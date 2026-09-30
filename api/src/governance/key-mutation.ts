import type { Request, RequestHandler, Response } from 'express';
import { KeyStoreWriteError } from './api-key-manager';
import { logger } from '../observability/logger';

/**
 * Wrap an API-key mutation handler so a failed key-store write is surfaced as
 * a 500 KEY_STORE_WRITE_FAILED instead of an unhandled rejection. The manager
 * has already rolled the mutation back by the time this sees the error.
 */
export function keyMutation(handler: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch((err: unknown) => {
        if (err instanceof KeyStoreWriteError) {
          logger.error('API key store write failed; mutation rolled back', err);
          res.status(500).json({
            success: false,
            error: {
              code: 'KEY_STORE_WRITE_FAILED',
              message: 'API key store write failed; the mutation was rolled back and not applied',
            },
          });
          return;
        }
        next(err);
      });
  };
}
