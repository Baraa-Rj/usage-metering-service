// AppError(status, code, message) and small factories the HTTP layer maps to responses.
export class AppError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
    
}
export const validationError = (message: string) => new AppError(400, "validation_error", message);
export const notFoundError = (message: string) => new AppError(404, "not_found", message);
export const internalError = (message: string) => new AppError(500, "internal_error", message);
export const conflictError = (message: string) => new AppError(409, "conflict", message);
export const idempotencyError =(message: string) => new AppError(409, "idempotency_error", message);
export const unauthorizedError = (message: string) => new AppError(401, "unauthorized", message);
export const forbiddenError = (message: string) => new AppError(403, "forbidden", message);