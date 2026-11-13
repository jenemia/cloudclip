import { handleApi } from '../../lib/api.js';

// Handles every /api/* request.
export const onRequest = ({ request, env }) => handleApi(request, env);
