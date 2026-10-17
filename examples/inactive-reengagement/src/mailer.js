import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
export async function send({ to, subject, html }) {
  return resend.emails.send({ from: 'Acme <hi@acme.com>', to, subject, html });
}
