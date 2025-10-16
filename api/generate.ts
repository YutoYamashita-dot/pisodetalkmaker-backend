// api/generate.ts
/// <reference types="node" />

import type { VercelRequest, VercelResponse } from '@vercel/node'
import OpenAI from "openai";
import { z } from "zod";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 入力のバリデーション
const InputSchema = z.object({
  theme: z.string().max(200).default(""),
  genre: z.string().max(100).default(""),
  characters: z.string().max(200).default(""),
  length: z.number().int().min(50).max(2000).default(350),
});

export const config = {
  runtime: "nodejs", // "edge"でも可（ただしNodeモジュール依存は注意）
};

// VercelのServerless関数
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // タイムアウト保険（30秒）
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);

  try {
    const parsed = InputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", detail: parsed.error.flatten() });
    }
    const { theme, genre, characters, length } = parsed.data;

    // ここを「エピソードトーク/漫才/コント」など用途で調整
    const system = `あなたは日本語の放送作家。読みやすく、笑いの理論（フリ→ボケ→ツッコミ、緩急、反復、三段落ち、誇張、対比）を自然に使って、会話体で原稿を作る。NG：誹謗中傷/差別/個人情報。`;
    const prompt = `
# お題
- テーマ: ${theme || "（未指定）"}
- ジャンル: ${genre || "（未指定）"}
- 登場人物: ${characters || "（未指定）"}

# 制約
- 文字数目安: 約${length}文字
- 読みやすい会話体。過度な記号や顔文字は禁止。

# 出力形式（厳守）
1) 「本文」のみ
2) 可能なら、構成と技法をJSONで返す補助テキストを最後に付けない（本文生成のみ）
`;

    // Chat Completions（2024年時点で安定）
    const completion = await client.chat.completions.create(
      {
        model: "gpt-4o-mini", // コスト/速度のバランス。予算に応じて変更可
        temperature: 0.8,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      },
      { signal: abort.signal }
    );

    const text = (completion.choices?.[0]?.message?.content ?? "").trim();

    // ここで「構成/技法」の簡易抽出（キーワードベース）※任意
    const structure: string[] = [];
    if (text.match(/(起|フリ)/)) structure.push("起（フリ）");
    if (text.match(/(承|展開)/)) structure.push("承（展開）");
    if (text.match(/(転|ボケ|どんでん返し)/)) structure.push("転（ボケ/意外性）");
    if (text.match(/(結|オチ)/)) structure.push("結（オチ）");

    const techniques: string[] = [];
    if (text.match(/(ボケ|ツッコミ)/)) techniques.push("ボケとツッコミ");
    if (text.match(/(三|3).*(段|ステップ)/)) techniques.push("三段落ち");
    if (text.match(/(反復|同じ)/)) techniques.push("反復");
    if (text.match(/(誇張|大げさ)/)) techniques.push("誇張");
    if (text.match(/(対比|ギャップ)/)) techniques.push("対比");

    clearTimeout(timer);
    return res.status(200).json({
      text,
      meta: { structure, techniques },
    });
  } catch (err: any) {
    clearTimeout(timer);
    const code = err?.name === "AbortError" ? 504 : 500;
    return res.status(code).json({ error: err?.message ?? "Server error" });
  }
}