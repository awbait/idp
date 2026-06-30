import { DiffEditor } from "@monaco-editor/react";
import { IconArrowNarrowRight, IconCircleCheck, IconCircleX, IconClock } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, HttpError } from "../api/client";
import type { ChartPublication, PublicationVersion } from "../api/types";
import { useCatalog } from "../app/CatalogContext";
import { useTheme } from "../app/ThemeContext";
import { useToast } from "../app/ToastContext";
import { Button, Card, Chip, TextField } from "./ui";

// VersionReview is the admin decision surface for one PENDING publication
// version: the view-document diff (approved vs the submitted draft) and the
// approve/reject controls. The per-version analogue of PublicationReview.
export function VersionReview({
  pubId,
  version,
  onReviewed,
}: {
  pubId: string;
  version: PublicationVersion;
  onReviewed: () => void;
}) {
  const { theme } = useTheme();
  const monacoTheme = theme === "light" ? "light" : "vs-dark";
  const { success } = useToast();
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [rejectComment, setRejectComment] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function onApprove() {
    setBusy("approve");
    setErr(null);
    try {
      await api.approveVersion(pubId, version.chart_version);
      success(`Версия ${version.chart_version} согласована`);
      onReviewed();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onReject() {
    setBusy("reject");
    setErr(null);
    try {
      await api.rejectVersion(pubId, version.chart_version, rejectComment.trim());
      success(`Версия ${version.chart_version} отклонена`);
      onReviewed();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col gap-3 border-amber-200">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Согласование версии</h2>
        <Chip className="bg-slate-100 text-slate-600">v{version.chart_version}</Chip>
      </div>
      {version.approved_view_json ? (
        <div className="overflow-hidden rounded-md border border-slate-200">
          <DiffEditor
            height="400px"
            language="json"
            theme={monacoTheme}
            original={JSON.stringify(version.approved_view_json, null, 2)}
            modified={JSON.stringify(version.view_json ?? {}, null, 2)}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 }}
          />
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          Первое согласование этой версии: действующего view для сравнения нет.
        </p>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField
            label="Комментарий (для отклонения)"
            value={rejectComment}
            onChange={(v) => setRejectComment(v)}
          />
        </div>
        <Button variant="primary" isDisabled={busy !== null} onPress={onApprove}>
          <IconCircleCheck size={16} stroke={1.8} /> Согласовать
        </Button>
        <Button variant="danger" isDisabled={busy !== null} onPress={onReject}>
          <IconCircleX size={16} stroke={1.8} /> Отклонить
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </Card>
  );
}

// ProposalChip: an amber "was -> now" chip for an unapproved metadata change.
function ProposalChip({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <Chip className="bg-amber-50 text-amber-700">
      <IconClock size={12} stroke={2} className="text-amber-500" aria-hidden />
      <span className="font-normal text-amber-500">{label}:</span>
      <span className="text-amber-600/70 line-through">{from}</span>
      <IconArrowNarrowRight size={13} stroke={2} className="text-amber-400" aria-hidden />
      {to}
    </Chip>
  );
}

// PublicationReview is the admin decision surface for a pending publication:
// proposed metadata changes, the view-document diff (approved vs draft), and the
// approve/reject controls. Extracted from the chart manage page so approval is a
// dedicated admin screen rather than a card on the owner's editor.
export function PublicationReview({ pub, onReviewed }: { pub: ChartPublication; onReviewed: () => void }) {
  const { categories } = useCatalog();
  const { theme } = useTheme();
  // Monaco lives outside Tailwind tokens: match its theme to the portal theme.
  const monacoTheme = theme === "light" ? "light" : "vs-dark";
  const { success } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [rejectComment, setRejectComment] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const catLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? id;
  // Unapproved metadata changes awaiting this decision.
  const proposals: { label: string; from: string; to: string }[] = [];
  if (pub.draft_category_id)
    proposals.push({ label: "Категория", from: catLabel(pub.category_id), to: catLabel(pub.draft_category_id) });
  if (pub.draft_owner_team) proposals.push({ label: "Владелец", from: pub.owner_team, to: pub.draft_owner_team });

  async function onApprove() {
    setBusy("approve");
    setErr(null);
    try {
      await api.approvePublication(pub.id);
      success("Публикация согласована");
      onReviewed();
      navigate("/admin/approvals");
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onReject() {
    setBusy("reject");
    setErr(null);
    try {
      await api.rejectPublication(pub.id, rejectComment.trim());
      success("Черновик отклонён");
      onReviewed();
      navigate("/admin/approvals");
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col gap-3 border-amber-200">
      <h2 className="text-sm font-semibold text-slate-800">Согласование</h2>
      {proposals.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-xs font-medium text-amber-800">Смена метаданных</p>
          <div className="flex flex-wrap gap-1.5">
            {proposals.map((p) => (
              <ProposalChip key={p.label} label={p.label} from={p.from} to={p.to} />
            ))}
          </div>
        </div>
      )}
      {pub.approved_view_json ? (
        <div className="overflow-hidden rounded-md border border-slate-200">
          <DiffEditor
            height="400px"
            language="json"
            theme={monacoTheme}
            original={JSON.stringify(pub.approved_view_json, null, 2)}
            modified={JSON.stringify(pub.view_json ?? {}, null, 2)}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 }}
          />
        </div>
      ) : (
        <p className="text-sm text-gray-500">Первая публикация view: действующей версии для сравнения нет.</p>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField
            label="Комментарий (для отклонения)"
            value={rejectComment}
            onChange={(v) => setRejectComment(v)}
          />
        </div>
        <Button variant="primary" isDisabled={busy !== null} onPress={onApprove}>
          <IconCircleCheck size={16} stroke={1.8} /> Согласовать
        </Button>
        <Button variant="danger" isDisabled={busy !== null} onPress={onReject}>
          <IconCircleX size={16} stroke={1.8} /> Отклонить
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </Card>
  );
}
