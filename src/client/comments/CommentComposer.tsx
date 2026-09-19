import { useState, type KeyboardEvent, type Ref } from "react";
import { COMMENT_LIMITS } from "../../shared/doc-schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * A text box with a submit and a cancel button, used for new comments, replies and edits.
 * Ctrl/⌘+Enter submits and Escape cancels. `onSubmit` returns false to keep the text.
 */
export function CommentComposer({
  label,
  placeholder,
  submitLabel,
  initial = "",
  autoFocus = false,
  collapsed = false,
  textareaRef,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  /** Hides the buttons until the box has text or focus (reply boxes). */
  collapsed?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (body: string) => boolean;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [focused, setFocused] = useState(autoFocus);
  const empty = body.trim() === "";

  const submit = () => {
    if (!empty && onSubmit(body)) setBody("");
  };
  const cancel = () => {
    setBody(initial);
    onCancel?.();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <div className="grid gap-2" onClick={(event) => event.stopPropagation()}>
      <Textarea
        ref={textareaRef}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        autoFocus={autoFocus}
        maxLength={COMMENT_LIMITS.bodyLength}
        rows={collapsed && !focused && empty ? 1 : 2}
        className="min-h-9 resize-none bg-background text-sm"
        onChange={(event) => setBody(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {(!collapsed || focused || !empty) && (
        <div className="flex justify-end gap-2">
          {(onCancel || !empty) && (
            <Button type="button" variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={cancel}>
              Cancel
            </Button>
          )}
          <Button type="button" size="sm" disabled={empty} onMouseDown={(event) => event.preventDefault()} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
