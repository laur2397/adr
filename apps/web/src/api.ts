/** Thin client for the Flux AM API: cookies for the session, X-Flux-Csrf on every request, problem+json errors. */

export interface ProblemError {
  field?: string;
  row?: number;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public errors: ProblemError[] = [],
    public code?: string,
  ) {
    super(title);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-flux-csrf': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Serverul nu poate fi contactat. Verificați conexiunea la rețea și încercați din nou.');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('flux:unauthorized'));
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, data?.title ?? `Eroare ${res.status}`, data?.errors ?? [], data?.code);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

export interface Me {
  id: string;
  username: string;
  fullName: string;
  email: string;
  roles: string[];
  totpEnabled: boolean;
  replacing: Array<{ id: string; fullName: string; scope: string }>;
  substitutedBy: Array<{ userId: string; fullName: string; scope: string; from: string; to: string }>;
}

export const can = {
  register: (me: Me) => me.roles.some((r) => ['registry_inspector', 'functional_admin'].includes(r)),
  readRegisters: (me: Me) => me.roles.some((r) => ['registry_inspector', 'functional_admin', 'head_of_unit', 'director', 'auditor'].includes(r)),
  dashboard: (me: Me) => me.roles.some((r) => ['head_of_unit', 'director', 'functional_admin', 'auditor'].includes(r)),
  admin: (me: Me) => me.roles.includes('functional_admin'),
  audit: (me: Me) => me.roles.some((r) => ['auditor', 'functional_admin', 'director', 'head_of_unit'].includes(r)),
  debts: (me: Me) => me.roles.some((r) => ['accountant', 'irregularity_officer', 'head_of_unit', 'director', 'functional_admin', 'auditor'].includes(r)),
  irregularities: (me: Me) => me.roles.some((r) => ['irregularity_officer', 'head_of_unit', 'director', 'functional_admin', 'auditor'].includes(r)),
  visits: (me: Me) => me.roles.some((r) => ['ei_expert', 'head_of_unit', 'director', 'functional_admin', 'auditor'].includes(r)),
  sampling: (me: Me) => me.roles.some((r) => ['head_of_unit', 'director', 'functional_admin', 'auditor'].includes(r)),
  archive: (me: Me) => me.roles.some((r) => ['registry_inspector', 'functional_admin', 'head_of_unit', 'director', 'auditor'].includes(r)),
  integrations: (me: Me) => me.roles.some((r) => ['functional_admin', 'it_admin'].includes(r)),
  validateLegal: (me: Me) => me.roles.some((r) => ['functional_admin', 'legal_advisor', 'director'].includes(r)),
};
