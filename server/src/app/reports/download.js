// L1 应用/用例层 — 报告实例 HTML 二进制下载。抽自 routes/reports_extra.js,逻辑逐行对齐。
// 二进制例外(recipe §5):返回 { data: Buffer, _binary:true, headers } —— 不碰 res;
// transport 层负责 Buffer → base64 的边界转换。
import { ApiError } from "../../errors.js";

// GET /api/projects/:pid/reports-v1/:rid/download — 下载报告 HTML
export async function downloadReport(ctx, input) {
  const { pid, rid } = input.params;
  const r = await ctx.queryOne(
    `SELECT id, title, html FROM generated_reports
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [rid, pid],
  );
  if (!r) throw new ApiError("报告不存在", 404);
  if (!r.html) throw new ApiError("报告内容为空", 404);

  const rawTitle = (r.title || "report").replace(/[/\\'"]/g, "_");
  const asciiFilename = "report.html";
  const encodedFilename = encodeURIComponent(rawTitle + ".html");

  return {
    data: Buffer.from(r.html, "utf-8"),
    _binary: true,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
    },
  };
}
