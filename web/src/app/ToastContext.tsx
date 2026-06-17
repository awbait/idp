import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { IconAlertCircle, IconCheck, IconX } from "@tabler/icons-react";

// Global toasts: success/error notifications in the bottom-right corner with
// auto-dismiss. Any page calls useToast().success(...) / .error(...).
// Lightweight implementation, no external deps (RAC Toast would be overkill here).

export type ToastTone = "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title?: string;
  text: string;
}

interface ToastOptions {
  title?: string;
  duration?: number; // ms; 0 = do not auto-dismiss
}

interface ToastApi {
  success: (text: string, opts?: ToastOptions) => void;
  error: (text: string, opts?: ToastOptions) => void;
  show: (tone: ToastTone, text: string, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// Default display time: errors stay longer so there's time to read them.
const DEFAULT_DURATION: Record<ToastTone, number> = { success: 3500, error: 8000 };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, text: string, opts?: ToastOptions) => {
      const id = ++nextId.current;
      setToasts((ts) => [...ts, { id, tone, text, title: opts?.title }]);
      const duration = opts?.duration ?? DEFAULT_DURATION[tone];
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (text, opts) => show("success", text, opts),
      error: (text, opts) => show("error", text, opts),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border bg-surface p-3 shadow-lg duration-300 animate-in fade-in slide-in-from-bottom-2 ${
        toast.tone === "error" ? "border-red-200" : "border-emerald-200"
      }`}
    >
      {toast.tone === "error" ? (
        <IconAlertCircle size={18} stroke={1.8} className="mt-px shrink-0 text-red-500" />
      ) : (
        <IconCheck size={18} stroke={2} className="mt-px shrink-0 text-emerald-500" />
      )}
      <div className="min-w-0 text-sm">
        {toast.title && <p className="font-medium text-slate-800">{toast.title}</p>}
        <p className={toast.title ? "mt-0.5 text-slate-600" : "text-slate-700"}>{toast.text}</p>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Закрыть"
        className="ml-1 shrink-0 rounded p-0.5 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <IconX size={16} />
      </button>
    </div>
  );
}
