// TypeScript view of process-definition.schema.json. Keep both in sync; the schema is the
// contract, these types are what the engine and the UI program against.

export type JsonLogic = Record<string, unknown> | boolean;

export type FieldType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'amount'
  | 'percent'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'choice'
  | 'multichoice'
  | 'user'
  | 'beneficiary'
  | 'project'
  | 'file'
  | 'line_items'
  | 'calculated';

export type ColumnType = 'text' | 'integer' | 'amount' | 'percent' | 'date' | 'choice' | 'file' | 'calculated';

export interface Validation {
  rule: JsonLogic;
  message: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  nomenclature?: string;
  formula?: JsonLogic;
  /** Result type of a calculated column (defaults to amount). */
  resultType?: 'amount' | 'integer' | 'percent' | 'text';
  total?: boolean;
}

export type PrefillSource = 'project' | 'beneficiary' | 'anaf' | 'previous_instance' | 'register_entry' | 'constant';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  nomenclature?: string;
  format?: 'cui' | 'iban' | 'smis_code' | 'email';
  min?: number;
  max?: number;
  pattern?: string;
  formula?: JsonLogic;
  resultType?: 'amount' | 'integer' | 'percent' | 'text' | 'boolean';
  prefill?: { from: PrefillSource; path?: string; value?: unknown };
  columns?: ColumnDef[];
  rowValidations?: Validation[];
}

export type FieldAccess = 'hidden' | 'visible' | 'editable' | 'required';

export type AssignmentRule =
  | 'fixed_user'
  | 'role_queue'
  | 'project_expert'
  | 'least_loaded'
  | 'previous_actor'
  | 'department_head'
  | 'chosen_by_previous';

export interface Assignment {
  rule: AssignmentRule;
  role?: string;
  user?: string;
  step?: string;
  department?: string;
}

export type ActionType =
  | 'set_field'
  | 'generate_document'
  | 'request_signatures'
  | 'notify'
  | 'register'
  | 'call_rest'
  | 'start_subflow'
  | 'grant_access'
  | 'pause_deadline'
  | 'resume_deadline'
  | 'update_budget_lines'
  | 'create_debt'
  | 'update_project';

export interface Action {
  type: ActionType;
  when?: JsonLogic;
  [option: string]: unknown;
}

export type PathKind = 'forward' | 'return' | 'reject';

export interface PathDef {
  key: string;
  label: string;
  to: string;
  kind?: PathKind;
  visibleWhen?: JsonLogic;
  requiresComment?: boolean;
  validateFields?: boolean;
  requiresChecklistComplete?: string;
  requiresSignatures?: string[];
  validations?: Validation[];
  actions?: Action[];
}

export type StepType =
  | 'start'
  | 'human'
  | 'system'
  | 'decision'
  | 'parallel_split'
  | 'parallel_join'
  | 'subflow'
  | 'end_positive'
  | 'end_negative';

export interface StepDef {
  key: string;
  type: StepType;
  name: string;
  assignment?: Assignment;
  fieldAccess?: Record<string, FieldAccess>;
  checklist?: string;
  checklistVerifier?: 'primary' | 'second';
  /** Photos with time and GPS position, and the representative's signature, can be captured here. */
  evidence?: boolean;
  deadline?: string;
  paths?: PathDef[];
  branches?: Array<{ to: string; when?: JsonLogic }>;
  join?: 'all' | 'any';
  next?: string;
  subflow?: string;
  /** subflow: child field key -> parent field key, copied when the child starts */
  inputs?: Record<string, string>;
  /** subflow: parent field key -> child field key (or $status), copied when the child ends */
  outputs?: Record<string, string>;
  onEnter?: Action[];
  onExit?: Action[];
}

export interface ProcessDefinition {
  schemaVersion: 1;
  key: string;
  name: string;
  description?: string;
  subject: {
    requires?: Array<'project' | 'beneficiary' | 'program' | 'register_entry'>;
    titleTemplate?: string;
  };
  fields: FieldDef[];
  checklists?: Array<{ key: string; template: string; verifierRoles?: Array<'primary' | 'second'> }>;
  documents?: Array<{ key: string; template: string; docType: string; pdf?: boolean; signatureLevel?: SignatureLevel; appendEvidence?: boolean }>;
  deadlines?: Array<{ key: string; definition: string; startsAt?: string; stopsAt?: string[]; when?: JsonLogic }>;
  separationOfDuties?: Array<{ steps: string[]; message: string }>;
  conflictOfInterest?: { steps: string[]; statement?: string };
  invoiceCheck?: { list: string; supplier: string; number: string; date?: string; amount?: string };
  steps: StepDef[];
}

export type SignatureLevel = 'simple' | 'advanced' | 'qualified' | 'seal';
