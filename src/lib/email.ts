import { Resend } from 'resend';
import { env } from './env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!resend) {
    console.log(`[email] to: ${message.to}\n[email] subject: ${message.subject}\n${message.text}`);
    return;
  }

  const { error } = await resend.emails.send({ from: env.EMAIL_FROM, ...message });

  if (error) {
    throw new Error(`Email delivery failed: ${error.message}`);
  }
}
