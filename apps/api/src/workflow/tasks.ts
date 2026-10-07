import { query, type Db } from '../core/db.js';
import { roleIdsFor, type CurrentUser } from '../identity/context.js';

export interface TaskRow {
  id: string;
  instance_id: string;
  execution_id: string;
  step_key: string;
  name: string;
  assignee_user_id: string | null;
  candidate_role_id: string | null;
  candidate_department_id: string | null;
  status: string;
  due_at: string | null;
}

/**
 * Whether the user can complete the task, and for whom: the assignee, a substitute of the
 * assignee (actions are recorded "on behalf of"), or a member of the queue's role/department.
 */
export function actingAs(user: CurrentUser, task: TaskRow, processKey: string): { ok: true; onBehalfOf: string | null } | { ok: false } {
  if (task.status !== 'open') return { ok: false };
  if (task.assignee_user_id) {
    if (task.assignee_user_id === user.id) return { ok: true, onBehalfOf: null };
    const sub = user.substitutes.find((s) => s.absentUserId === task.assignee_user_id && (!s.processKey || s.processKey === processKey));
    return sub ? { ok: true, onBehalfOf: task.assignee_user_id } : { ok: false };
  }
  if (task.candidate_role_id && roleIdsFor(user, processKey).includes(task.candidate_role_id)) return { ok: true, onBehalfOf: null };
  if (task.candidate_department_id && task.candidate_department_id === user.departmentId) return { ok: true, onBehalfOf: null };
  return { ok: false };
}

export async function openTasks(db: Db, instanceId: string): Promise<TaskRow[]> {
  return query<TaskRow>(db, `select * from task where instance_id = $1 and status = 'open' order by created_at`, [instanceId]);
}
