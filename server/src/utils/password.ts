import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>

const KEY_LENGTH = 64
const SALT_LENGTH = 16

export interface PasswordHash {
  salt: string
  hash: string
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_LENGTH).toString('hex')
  const derived = await scrypt(password, salt, KEY_LENGTH)
  return { salt, hash: derived.toString('hex') }
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (!stored?.salt || !stored?.hash) return false

  const derived = await scrypt(password, stored.salt, KEY_LENGTH)
  const expected = Buffer.from(stored.hash, 'hex')
  if (expected.length !== derived.length) return false
  return timingSafeEqual(derived, expected)
}
