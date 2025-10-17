// api/generate.ts
import OpenAI from "openai";
import { z } from "zod";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const InputSchema = z.object({
  theme: z.string().max(200).default(""),
  genre: z.string().max(100).default(""),
  characters: z.string().max(200).default(""),
  length: z.number().int().min(50).max(1000).default(350),
});

export const config = { runtime: "nodejs" };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS（必要ならドメインを絞る）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);

  try {
    const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", detail: parsed.error.flatten() });
    }
    const { theme, genre, characters, length } = parsed.data;

    // 「たまに」三段落ちを使う（35%）
    const useSandanOchi = Math.random() < 0.35;

    const system = `あなたは日本語の放送作家。聞き手を惹きつける「エピソードトーク」を会話体で作る。
- 構成：導入（状況/関係/前提）→膨らまし（勘違い・誇張・比喩・対比）→必ず中盤〜終盤に「どんでん返し」→回収（学び/共感）
- 笑い：全体で3箇所以上の小さな笑い（小ボケ/内心ツッコミ/軽い誇張/言い間違い/ミスリード）を小刻みに配置。各パートに最低1つは入れる。
- コールバック：1〜2回。しつこくならない程度に同キーワード/比喩を再登場させ、最後の回収に活かす。
- テンポ：短い文でリズム。会話体と地の文を交互に。
- キャラ：自虐・共感は適度に。相手は悪者にしない。
- NG：誹謗中傷/差別/個人情報/過度な下品、固有名連発。`;

    const sandanInstruction = useSandanOchi
      ? `
- 可能なら**三段落ち**を使う：似た展開や言い回しを「一つ目→二つ目→三つ目」で積み上げ、三つ目で予想をズラして落とす（軽いギャップや認識反転）。過剰に長くせずテンポ重視。`
      : "";

    const user = `
# お題
- テーマ: ${theme || "（未指定）"}
- トーン(genre): ${genre || "（未指定）"}
- 登場人物: ${characters || "（未指定）"}

# 制約
- 目安文字数: 約${length}文字（超えない）
- 出力フォーマット（見出しは厳守）：
  タイトル

  [導入]
  （状況・前提・関係性を1〜2行。ここで軽い笑いを1つ）

  [本編]
  （セリフ「A: 〜」「自分: 〜」や地の文でテンポよく。2〜3箇所の小さな笑い：小ボケ/内心ツッコミ/誇張）${sandanInstruction}

  [どんでん返し]
  （意外な真相/解釈/立場の反転を1〜3行。前半のディテールを回収）

  [オチ/学び]
  （軽い意外性から共感のある回収。コールバックで気持ちよく締める）
`.trim();

    const completion = await client.chat.completions.create(
      {
        model: "gpt-4o-mini",
        temperature: 0.9,
        max_tokens: 1400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      { signal: abort.signal }
    );

    let text = (completion.choices?.[0]?.message?.content ?? "").trim();

    // ── メタ抽出
    const structure: string[] = [];
    if (/\[導入\]|導入/.test(text)) structure.push("導入");
    if (/\[本編\]|本編/.test(text)) structure.push("本編");
    if (/\[どんでん返し\]|どんでん返し/.test(text)) structure.push("どんでん返し");
    if (/\[オチ\/学び\]|オチ|学び/.test(text)) structure.push("オチ/学び");

    const techniques: string[] = [];
    if (/コールバック|またあれか|さっきの|例の件/.test(text)) techniques.push("コールバック");
    if (/比喩|たとえ|まるで/.test(text)) techniques.push("比喩");
    if (/対比|ギャップ/.test(text)) techniques.push("対比");
    if (/（心の声|心の中|内心|ツッコミ）/.test(text) || /いやいや|いや待て|ってなんでやねん/.test(text))
      techniques.push("内心ツッコミ");
    if (/小ボケ|言い間違い|勘違い|ズレ|肩透かし/.test(text)) techniques.push("小ボケ");
    if (/誇張|大げさ|盛りすぎ/.test(text)) techniques.push("誇張");
    if (/\[どんでん返し\]|どんでん返し|意外な真相|反転|逆転|覆る/.test(text)) techniques.push("どんでん返し");
    if (/自分:|A:|B:|C:/.test(text)) techniques.push("会話体");

    // 三段落ちの検出（明示 or パターン）
    const sandanRegexes = [
      /三段落ち/,
      /(一つ目|1つ目|まず).+(二つ目|2つ目|次に).+(三つ目|3つ目|最後に)/s,
      /(A|その1).+(B|その2).+(C|その3)/s,
    ];
    if (sandanRegexes.some((r) => r.test(text))) {
      techniques.push("三段落ち");
    }

    // どんでん返し見出しが漏れた場合の保険
    if (!/\[どんでん返し\]/.test(text)) {
      text += `

[どんでん返し]
実は「自分」が思い込んでいた前提そのものが誤解で、相手の善意や自分の勘違いが鍵だった——という形で話が反転する。`;
      if (!structure.includes("どんでん返し")) structure.push("どんでん返し");
      if (!techniques.includes("どんでん返し")) techniques.push("どんでん返し");
    }

    return res.status(200).json({ text, meta: { structure, techniques } });
  } catch (err: any) {
    const code = err?.name === "AbortError" ? 504 : 500;
    return res.status(code).json({ error: err?.message ?? "Server error" });
  } finally {
    clearTimeout(timer);
  }
}