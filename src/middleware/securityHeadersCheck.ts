import { Request, Response, NextFunction } from 'express'
import { MissingSecurityHeaderError } from '../lib/errors.js'

const REQUIRED_HEADERS = [
  'content-security-policy',
  'strict-transport-security',
  'referrer-policy',
  'cross-origin-resource-policy',
  'x-content-type-options',
] as const

type RequiredHeader = typeof REQUIRED_HEADERS[number]

export interface SecurityHeaderCheckResult {
  missing: RequiredHeader[]
  present: RequiredHeader[]
}

export function checkSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const missing: RequiredHeader[] = []

  for (const header of REQUIRED_HEADERS) {
    if (!res.getHeader(header)) {
      missing.push(header)
    }
  }

  if (missing.length > 0) {
    return next(
      new MissingSecurityHeaderError(
        `Missing required security headers: ${missing.join(', ')}`,
        missing
      )
    )
  }

  next()
}