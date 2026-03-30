import { getServerSession } from 'next-auth';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyToken(token: string): Promise<boolean> {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET not set');
  jwt.verify(token, secret);
  return true;
}

export async function getSession() {
  return getServerSession();
}
