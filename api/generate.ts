// api/generate.ts
import OpenAI from "openai";
import { z } from "zod";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  // Vercel のビルドログで気付けるように
  console.warn("[WARN] OPENAI_API_KEY is not set.");
}
const client = new OpenAI({ apiKey: apiKey ?? "" });

// ===== 入力のバリデーション =====
const InputSchema = z.object({
  theme: z.string().max(200).default(""),
  genre: z.string().max(100).default(""),
  characters: z.string().max(200).default(""),
  length: z.number().int().min(50).max(1000).default(350),
});

export const config = { runtime: "nodejs" };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== CORS（プリフライト含む）=====
  // 開発中は "*" でOK。本番は自分のフロント（例: https://pisodetalkmaker.vercel.app）に絞るのが安全。
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ヘルスチェックや簡易確認用
  if (req.method === "GET") {
    return res
      .status(200)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .json({ ok: true, route: "/api/generate" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS, GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on server." });
  }

  // サーバ側タイムアウト保険（30秒）
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);

  try {
    // Android/ブラウザ双方から来るケースを吸収
    const raw =
      typeof req.body === "string" && req.body.length
        ? JSON.parse(req.body)
        : (req.body ?? {});
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid input", detail: parsed.error.flatten() });
    }
    const { theme, genre, characters, length } = parsed.data;

    // 「たまに」三段落ちを使う（35%）
    const useSandanOchi = Math.random() < 0.35;

    // 期待文字数→max_tokens（和文は 1 文字 ≒ 1〜2 token を想定して余裕を持たせる）
    const maxTokens = Math.min(2400, Math.max(600, Math.round(length * 2.4)));

    // ===== プロンプト =====
    // JSONだけを返させるため、response_format + 明示スキーマを併用
    const system = [
      "あなたは日本語の放送作家です。",
      "聞き手を惹きつける『エピソードトーク』を作成します。",
      "NG：誹謗中傷・差別・個人情報・過度に下品な表現・固有名連発。",
      "必ず JSON だけを返します（説明文・前置き・Markdownは禁止）。",
      'JSONスキーマ: {"title": string, "body": string, "meta": {"structure": string[], "techniques": string[]}}',
    ].join("\n");

    const sandanInstruction = useSandanOchi
      ? "- 可能なら**三段落ち**を使う：似た展開や言い回しを「一つ目→二つ目→三つ目」で積み上げ、三つ目で予想をズラして落とす（テンポ重視・簡潔に）。"
      : "";

    const minBody = Math.max(220, Math.round(length * 0.75)); // 短文を避ける下限目安
    const user = `
# お題
- テーマ: ${theme || "（未指定）"}
- トーン(genre): ${genre || "（未指定）"}
- 登場人物: ${characters || "（未指定）"}

# 制約
- 本文の目安文字数: ${minBody}〜${length}字（上限1000字を超えない）
- 構成: 導入（状況/関係/前提）→膨らまし（勘違い・誇張・比喩・対比）→**どんでん返し**（必ず入れる）→回収（学び/共感）
- **途中に小さな笑い**を3箇所以上（小ボケ/内心ツッコミ/軽い誇張/言い間違い/ミスリード）。各パートに最低1つ。
- コールバック：1〜2回。しつこくならない程度に同キーワード/比喩を再登場させ、最後の回収に活かす。
- テンポ：短文でリズム。会話体と地の文を交互に。
- キャラ：自虐・共感は適度に。相手は悪者にしない。
${sandanInstruction}

# 出力（**JSONのみ**）
{
  "title": "短くキャッチーなタイトル（本文と重複させない）",
  "body": "本文（見出しやMarkdownは使わない。『導入/本編/どんでん返し/オチ』の流れが自然に分かるよう、会話体＋地の文で書く。${minBody}字以上を目安にする）",
  "meta": {
    "structure": ["導入","膨らまし","どんでん返し","回収"],
    "techniques": ["どんでん返し","反復","誇張","対比"${useSandanOchi ? ',"三段落ち"' : ""}]
  }
}
`.trim();

    // ===== 呼び出し =====
    const completion = await client.chat.completions.create(
      {
        model: "gpt-5",
        temperature: 0.75,
        top_p: 0.95,
        max_tokens: maxTokens,
        response_format: { type: "json_object" }, // JSON強制
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      { signal: abort.signal }
    );

    let content = (completion.choices?.[0]?.message?.content ?? "").trim();

    // ===== JSONとして解釈（失敗時フォールバック）=====
    type Payload = {
      title?: string;
      body?: string;
      meta?: { structure?: string[]; techniques?: string[] };
    };

    let payload: Payload;
    try {
      payload = JSON.parse(content);
    } catch {
      // JSONが崩れたときでもアプリが落ちないように
      return res
        .status(200)
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .json({
          title: "タイトル未取得",
          body: content,
          meta: { structure: [], techniques: [] },
          note:
            "モデル出力がJSON形式を満たしていないためフォールバックで返却しました。",
        });
    }

    const title = (payload.title ?? "").toString().trim();
    const body = (payload.body ?? "").toString().trim();
    const meta = payload.meta ?? {};
    const structure: string[] = Array.isArray(meta.structure) ? meta.structure : [];
    const techniques: string[] = Array.isArray(meta.techniques) ? meta.techniques : [];

    // 短文すぎる場合（アプリ側の「短すぎ」見た目原因になりやすい）
    if (body.length < minBody * 0.8) {
      return res
        .status(200)
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .json({
          title: title || "（短文のため要再生成）",
          body,
          meta: { structure, techniques },
          note:
            "短めの結果です。文字数を少し大きめにして再生成すると改善する場合があります。",
        });
    }

    return res
      .status(200)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .json({ title, body, meta: { structure, techniques } });
  } catch (err: any) {
    const code = err?.name === "AbortError" ? 504 : 500;
    return res
      .status(code)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .json({ error: err?.message ?? "Server error" });
  } finally {
    clearTimeout(timer);
  }
}