import type { IncomingMessage, ServerResponse } from 'node:http';
export function handleModules(req: IncomingMessage, res: ServerResponse, url: URL, fetcher?: typeof fetch): Promise<boolean>;
