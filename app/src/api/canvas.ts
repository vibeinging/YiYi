export interface CanvasEvent {
  canvas_id: string;
  session_id: string;
  title?: string;
  components: CanvasComponent[];
}

// ── Component types ──

export interface CardComponent {
  type: 'card';
  id?: string;
  title: string;
  description?: string;
  image?: string;
  accent?: string;
  tags?: string[];
  footer?: string;
}

export interface StatusComponent {
  type: 'status';
  id?: string;
  steps: StatusStep[];
}

export interface StatusStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface TableComponent {
  type: 'table';
  id?: string;
  headers: string[];
  rows: unknown[][];
}

export interface ActionsComponent {
  type: 'actions';
  id: string;
  buttons: ActionButton[];
}

export interface ActionButton {
  label: string;
  action: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface ListComponent {
  type: 'list';
  id?: string;
  items: ListItem[];
}

export interface ListItem {
  title: string;
  subtitle?: string;
  icon?: string;
  badge?: string;
}

export interface FormComponent {
  type: 'form';
  id: string;
  title: string;
  fields: FormField[];
}

export interface FormField {
  name: string;
  label: string;
  field_type?: 'text' | 'email' | 'number' | 'select' | 'textarea' | 'toggle';
  placeholder?: string;
  options?: string[];
  required?: boolean;
}

export type CanvasComponent =
  | CardComponent
  | StatusComponent
  | TableComponent
  | ActionsComponent
  | ListComponent
  | FormComponent;

export type CanvasActionHandler = (
  canvasId: string,
  componentId: string,
  action: string,
  value?: unknown
) => void;
