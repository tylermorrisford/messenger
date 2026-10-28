import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { HttpError } from './lib/http-error.js';
import authRoutes from './routes/auth.routes.js';
import inviteRoutes from './routes/invite.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import eventsRoutes from './routes/events.routes.js';
import userRoutes from './routes/user.routes.js';

// Create Express app
const app = express();
const PORT = env.PORT;

// behind the tunnel the socket peer is the cloudflared pod; Cloudflare appends the client IP to X-Forwarded-For
app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

// Security middleware
app.use(helmet()); // Security headers
app.use(cors({ origin: env.APP_ORIGIN, credentials: true }));

// Request parsing
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(cookieParser());

// Logging
if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev')); // HTTP request logger
}

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    res.status(503).json({
      success: false,
      error: 'Database unreachable',
    });
    return;
  }

  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/users', userRoutes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
  });
});

// Global error handler
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }

  console.error('Error:', err);

  res.status(500).json({
    success: false,
    error: env.NODE_ENV === 'production' || !(err instanceof Error)
      ? 'Internal server error'
      : err.message,
  });
});

// Start server
if (env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
    console.log(`💚 Health check: http://localhost:${PORT}/health\n`);
  });
}

export default app;
