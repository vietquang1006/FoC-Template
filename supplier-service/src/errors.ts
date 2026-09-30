import type { FieldError } from './domain/validation.ts'

// An error the API reports to the caller as-is. Anything else is a bug and is
// reported as a plain 500 without details.
export class HttpError extends Error {
  status: number
  code: string
  fields: FieldError[] | undefined

  constructor(status: number, code: string, message: string, fields?: FieldError[]) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Supplier not found')

export const validationFailed = (fields: FieldError[]) =>
  new HttpError(400, 'VALIDATION_FAILED', 'One or more fields are invalid', fields)
