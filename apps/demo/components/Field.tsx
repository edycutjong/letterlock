"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { formatBytes, utf8Bytes } from "@/lib/format.ts";
import styles from "./Field.module.css";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  /** a form error (e.g. INPUT_INVALID for a malformed address), shown under the field and announced */
  error?: string;
  /** set addresses and agent ids in the data face */
  data?: boolean;
};

/** A line on a postal form: a label in capitals, a ruled box to write in, a hint underneath. */
export function TextField({ label, hint, error, data, className, ...input }: TextFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={[styles.field, className].filter(Boolean).join(" ")} data-invalid={error ? "" : undefined}>
      <label htmlFor={id} className="label-caps">
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={[styles.input, data && styles.data].filter(Boolean).join(" ")}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        spellCheck={data ? false : input.spellCheck}
        autoCapitalize={data ? "off" : input.autoCapitalize}
        autoComplete={input.autoComplete ?? "off"}
      />
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type NoteFieldProps = {
  label: string;
  defaultValue?: string;
  /** the most bytes a note may have; the counter turns to a warning past it */
  maxBytes?: number;
  placeholder?: string;
  rows?: number;
  className?: string;
};

/** The note, written on a ruled letter sheet, with its size counted live in UTF-8 bytes (what the envelope carries). */
export function NoteField({ label, defaultValue = "", maxBytes, placeholder, rows = 4, className }: NoteFieldProps) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const bytes = utf8Bytes(value);
  const over = maxBytes !== undefined && bytes > maxBytes;
  return (
    <div className={[styles.field, className].filter(Boolean).join(" ")} data-invalid={over ? "" : undefined}>
      <label htmlFor={id} className="label-caps">
        {label}
      </label>
      <textarea
        id={id}
        className={styles.note}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        aria-describedby={`${id}-count`}
        aria-invalid={over || undefined}
      />
      <p id={`${id}-count`} className={styles.count} aria-live="polite">
        {formatBytes(bytes)}
        {maxBytes !== undefined && <> of {formatBytes(maxBytes)}</>}
      </p>
    </div>
  );
}
