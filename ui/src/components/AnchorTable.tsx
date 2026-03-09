import type { Anchor } from "../types";

export default function AnchorTable({ anchors }: { anchors: Anchor[] }) {
  if (anchors.length === 0) return null;

  return (
    <table className="anchor-table">
      <thead>
        <tr>
          <th>memory_id</th>
          <th>final_weight</th>
          <th>w_time</th>
          <th>w_sent</th>
          <th>cosine</th>
        </tr>
      </thead>
      <tbody>
        {anchors.map((a) => (
          <tr key={a.memory_id}>
            <td><span className="memory-id">{a.memory_id}</span></td>
            <td>{fmt(a.final_weight)}</td>
            <td>{fmt(a.w_time)}</td>
            <td>{fmt(a.w_sent)}</td>
            <td>{fmt(a.cosine)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(v: number | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "—";
}
