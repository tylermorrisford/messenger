import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import authRoutes from './routes/auth.routes.js';
import messageRoutes from './routes/message.routes.js';

// Create Express app
const app = express();
const PORT = env.PORT;

// Security middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS for all origins (configure for production)

// Request parsing
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

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
app.use('/api/messages', messageRoutes);

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Welcome to the Messaging API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me (requires auth)',
        users: 'GET /api/auth/users (requires auth)',
      },
      messages: {
        getAll: 'GET /api/messages',
        getOne: 'GET /api/messages/:id',
        getByUser: 'GET /api/messages/user/:userId',
        create: 'POST /api/messages (requires auth)',
        update: 'PUT /api/messages/:id (requires auth)',
        delete: 'DELETE /api/messages/:id (requires auth)',
      },
    },
    documentation: 'See README.md for detailed API documentation',
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);

  res.status(500).json({
    success: false,
    error: env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// Start server
if (env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📚 API Documentation: http://localhost:${PORT}`);
    console.log(`💚 Health check: http://localhost:${PORT}/health\n`);
  });
}

export default app;
