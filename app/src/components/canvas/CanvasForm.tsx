import React, { useState } from 'react';
import type { FormComponent, FormField, CanvasActionHandler } from '../../api/canvas';

interface CanvasFormProps {
  data: FormComponent;
  canvasId: string;
  onAction?: CanvasActionHandler;
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  minHeight: 44,
  boxSizing: 'border-box',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-bg-subtle)',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: '13px',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  marginBottom: 3,
};

const SUBMIT_STYLE: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 20px',
  minHeight: 44,
  borderRadius: 'var(--radius-full)',
  background: 'var(--color-primary)',
  color: 'var(--color-bg)',
  border: 'none',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
};

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const fieldType = field.field_type ?? 'text';
  const strValue = (value as string) ?? '';
  const requiredMark = field.required ? ' *' : '';

  if (fieldType === 'toggle') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44 }}>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          aria-required={field.required || undefined}
        />
        <span style={{ fontSize: '13px', color: 'var(--color-text)' }}>
          {field.label}{requiredMark}
        </span>
      </label>
    );
  }

  if (fieldType === 'select' && field.options) {
    return (
      <div>
        <label style={LABEL_STYLE}>{field.label}{requiredMark}</label>
        <select
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          aria-required={field.required || undefined}
          style={INPUT_STYLE}
        >
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (fieldType === 'textarea') {
    return (
      <div>
        <label style={LABEL_STYLE}>{field.label}{requiredMark}</label>
        <textarea
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          aria-required={field.required || undefined}
          style={{ ...INPUT_STYLE, resize: 'vertical' }}
        />
      </div>
    );
  }

  return (
    <div>
      <label style={LABEL_STYLE}>{field.label}{requiredMark}</label>
      <input
        type={fieldType}
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        style={INPUT_STYLE}
      />
    </div>
  );
}

export const CanvasForm = React.memo(function CanvasForm({ data, canvasId, onAction }: CanvasFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitted, setSubmitted] = useState(false);

  const handleChange = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAction?.(canvasId, data.id, 'form_submitted', values);
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div
        role="status"
        style={{ padding: 12, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}
      >
        Submitted
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-label={data.title}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 10 }}>
        {data.title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.fields.map((field: FormField) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(v) => handleChange(field.name, v)}
          />
        ))}
      </div>
      <button type="submit" style={SUBMIT_STYLE}>
        {data.title}
      </button>
    </form>
  );
});
