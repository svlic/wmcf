# Frontend API contract

The canonical HTTP contract is [`API_CONTRACT.md`](../API_CONTRACT.md).

## Frontend integration

- **Validation**: Zod schemas live in `src/api/schemas.ts`; `src/api/client.ts` parses responses and throws `ApiError` on mismatch.
- **Instrument by id**: There is no `GET /api/instruments/{id}`; `getInstrument` loads `GET /api/instruments` and selects by numeric `id`.
- **Auth**: The UI initializes a fresh deployment through `/api/setup`, then uses `/api/auth/*` and sends cookies on API calls.

For route tables and response field definitions, use the canonical contract only.