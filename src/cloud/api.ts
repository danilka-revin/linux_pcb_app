import type { Doc } from '../pcb/model';

export interface CloudUser {
  id: string; email: string; role: 'admin' | 'user'; createdAt: number;
  mustChangePassword?: boolean;
}
export interface CloudConfig {
  enabled: boolean;
  registrationOpen?: boolean;
  twoFactorRequired?: boolean;
  maxProjectBytes?: number;
  quotaBytes?: number;
}
export interface CloudProject {
  id: string; ownerId: string; name: string; version: number;
  bytes: number; entityCount: number; createdAt: number; updatedAt: number;
  ownerEmail?: string;
  accessRole?: 'owner' | 'editor';
}
export interface ProjectMember {
  id: string; email: string; role: 'owner' | 'editor'; online?: boolean; joinedAt?: number;
}
export interface ProjectParticipant extends ProjectMember { online: boolean }
export interface SyncResponse {
  project: CloudProjectDetail | null;
  participants: ProjectParticipant[];
  changed: boolean;
  serverTime: number;
}
export interface CloudProjectDetail extends CloudProject { document: Doc }
export interface CloudOverview {
  users: number; disabledUsers: number; verifiedUsers: number; unverifiedUsers: number;
  usersMustChangePassword: number; projects: number; bytes: number;
  activeSessions: number; registrationOpen: boolean; quotaBytes: number; maxProjectBytes: number;
}
export interface AdminUser extends CloudUser {
  disabled: boolean; lastLogin: number | null; emailVerifiedAt: number | null;
  mustChangePassword: boolean; projectCount: number; sharedProjectCount: number;
  versionCount: number; activeSessions: number; bytes: number;
}
export interface AdminUserSession { createdAt: number; expiresAt: number }
export interface CloudEvent {
  id: number; actorId: string | null; actorEmail: string | null;
  action: string; targetId: string | null; detail: string; at: number;
}
export interface AdminUserProfile {
  user: AdminUser;
  twoFactorRequired: boolean;
  ownedProjects: CloudProject[];
  sharedProjects: CloudProject[];
  projectCount: number; sharedProjectCount: number; versionCount: number;
  bytes: number; sharedBytes: number; quotaBytes: number;
  activeSessions: AdminUserSession[]; actionCount: number; recentEvents: CloudEvent[];
}

export class CloudError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Только относительные URL: браузеры других машин обращаются к своему серверу, не к localhost. */
export async function cloudApi<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/cloud' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json', 'x-psbees-request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new CloudError('Сервер недоступен. Проверьте подключение и повторите.', 0);
  }
  let data: { ok?: boolean; error?: string };
  try { data = await response.json() as typeof data; }
  catch { throw new CloudError('Сервер вернул некорректный ответ.', response.status); }
  if (!response.ok || data.ok === false) throw new CloudError(data.error || `Ошибка сервера (HTTP ${response.status}).`, response.status);
  return data as T;
}

export function cloudError(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка сервера.';
}
export function cloudDate(value: number): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
export function cloudBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КиБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МиБ`;
}
