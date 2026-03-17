"""LLM Service — provider-abstracted LLM integration for Canary.

Templates handle 90% of messages. LLM is used for:
- Weekly recap summaries
- Drop post-mortem analysis
- Prediction narrative generation

Supports Claude (Anthropic) and GPT (OpenAI) with automatic fallback
to template-based output when LLM is unavailable.

Environment variables:
    LLM_PROVIDER    — "anthropic" or "openai" (default: anthropic)
    ANTHROPIC_API_KEY — Anthropic API key
    OPENAI_API_KEY   — OpenAI API key
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Optional

import httpx

log = logging.getLogger("canary.llm")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "anthropic")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

SYSTEM_PROMPT = (
    "You are the Canary analyst — an expert Pokemon TCG market analyst. "
    "Write concise, informative summaries for Pokemon TCG collectors. "
    "Use a confident but measured tone. Include specific data points. "
    "Never speculate beyond what the data shows. "
    "Format for Discord embeds: use **bold** for emphasis, keep paragraphs short. "
    "Maximum response length: 300 words."
)


# ---------------------------------------------------------------------------
# Prompt templates (structured JSON context → LLM)
# ---------------------------------------------------------------------------

PROMPT_TEMPLATES = {
    "weekly_recap": {
        "instruction": (
            "Write a weekly recap for the Pokemon Center UK drop monitoring service. "
            "Summarise what happened this week in 2-3 short paragraphs. "
            "Include: number of drops, products involved, queue durations, "
            "any notable signals or community buzz. End with a brief outlook "
            "for next week based on the prediction data."
        ),
        "fallback": (
            "📋 **Weekly Recap**\n\n"
            "This week we tracked **{drop_count}** drop event(s) and detected "
            "**{signal_count}** signals. {drop_summary}\n\n"
            "**Next week outlook:** {prediction_summary}"
        ),
    },
    "drop_postmortem": {
        "instruction": (
            "Write a brief post-mortem analysis of a Pokemon Center drop that just ended. "
            "Cover: what dropped, how long the queue lasted, which products were involved, "
            "and any notable observations. Keep it to 1-2 short paragraphs."
        ),
        "fallback": (
            "📊 **Drop Summary**\n\n"
            "The drop lasted **{duration}** with a queue time of approximately "
            "{queue_time}. Products involved: {products}."
        ),
    },
    "prediction_narrative": {
        "instruction": (
            "Convert the following structured drop prediction data into a natural, "
            "conversational paragraph. Explain the prediction in terms a Pokemon TCG "
            "collector would understand. Mention the predicted day/time, confidence level, "
            "and the key signals driving the prediction. Keep it to 2-3 sentences."
        ),
        "fallback": (
            "🔮 Based on historical patterns, the next drop is predicted for "
            "**{day_of_week}** around **{time_range}** with **{confidence}%** confidence. "
            "{reasoning}"
        ),
    },
}


# ---------------------------------------------------------------------------
# Core LLM call
# ---------------------------------------------------------------------------

async def _call_anthropic(messages: list[dict], max_tokens: int = 500) -> Optional[str]:
    """Call Anthropic Claude API."""
    if not ANTHROPIC_API_KEY:
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": ANTHROPIC_MODEL,
                    "max_tokens": max_tokens,
                    "system": SYSTEM_PROMPT,
                    "messages": messages,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("content", [])
                if content and content[0].get("type") == "text":
                    return content[0]["text"]
            else:
                log.warning(f"Anthropic API error {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log.warning(f"Anthropic API call failed: {e}")

    return None


async def _call_openai(messages: list[dict], max_tokens: int = 500) -> Optional[str]:
    """Call OpenAI Chat Completions API."""
    if not OPENAI_API_KEY:
        return None

    try:
        oai_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for m in messages:
            oai_messages.append({"role": m["role"], "content": m["content"]})

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": OPENAI_MODEL,
                    "max_tokens": max_tokens,
                    "messages": oai_messages,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0]["message"]["content"]
            else:
                log.warning(f"OpenAI API error {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log.warning(f"OpenAI API call failed: {e}")

    return None


async def call_llm(prompt: str, max_tokens: int = 500) -> Optional[str]:
    """Call the configured LLM provider. Returns None on failure."""
    messages = [{"role": "user", "content": prompt}]

    if LLM_PROVIDER == "openai":
        result = await _call_openai(messages, max_tokens)
        if result:
            return result
        return await _call_anthropic(messages, max_tokens)
    else:
        result = await _call_anthropic(messages, max_tokens)
        if result:
            return result
        return await _call_openai(messages, max_tokens)


# ---------------------------------------------------------------------------
# High-level generation functions
# ---------------------------------------------------------------------------

async def generate_weekly_recap(context: dict) -> str:
    """Generate a weekly recap summary.

    Context should include:
        drop_events: list of drop event dicts from this week
        signals: list of signal dicts from this week
        prediction: current prediction dict
        products: list of recently detected products
    """
    template = PROMPT_TEMPLATES["weekly_recap"]

    prompt = (
        f"{template['instruction']}\n\n"
        f"## Data\n"
        f"```json\n{json.dumps(context, indent=2, default=str)}\n```"
    )

    result = await call_llm(prompt, max_tokens=600)
    if result:
        return result

    # Fallback to template
    drops = context.get("drop_events", [])
    signals = context.get("signals", [])
    prediction = context.get("prediction", {})

    drop_summary = ""
    if drops:
        products = []
        for d in drops:
            p = d.get("products", "[]")
            if isinstance(p, str):
                try:
                    products.extend(json.loads(p))
                except Exception:
                    pass
        if products:
            drop_summary = f"Products involved: {', '.join(products[:5])}."
    else:
        drop_summary = "No drops occurred this week."

    pred_conf = prediction.get("confidence", 0)
    pred_day = prediction.get("day_of_week", "Unknown")
    prediction_summary = (
        f"Next predicted window: **{pred_day}** "
        f"({int(pred_conf * 100)}% confidence)."
    )

    return template["fallback"].format(
        drop_count=len(drops),
        signal_count=len(signals),
        drop_summary=drop_summary,
        prediction_summary=prediction_summary,
    )


async def generate_drop_postmortem(context: dict) -> str:
    """Generate a post-mortem analysis for a drop that just ended.

    Context should include:
        event: the drop_event dict
        signals: signals that fired during the drop
    """
    template = PROMPT_TEMPLATES["drop_postmortem"]

    prompt = (
        f"{template['instruction']}\n\n"
        f"## Data\n"
        f"```json\n{json.dumps(context, indent=2, default=str)}\n```"
    )

    result = await call_llm(prompt, max_tokens=400)
    if result:
        return result

    # Fallback
    event = context.get("event", {})
    duration_secs = event.get("duration_secs", 0)
    if duration_secs:
        hours = duration_secs // 3600
        mins = (duration_secs % 3600) // 60
        duration = f"{hours}h {mins}m" if hours else f"{mins} minutes"
    else:
        duration = "unknown duration"

    products_raw = event.get("products", "[]")
    if isinstance(products_raw, str):
        try:
            products = json.loads(products_raw)
        except Exception:
            products = []
    else:
        products = products_raw

    return template["fallback"].format(
        duration=duration,
        queue_time=duration,
        products=", ".join(products) if products else "Unknown products",
    )


async def generate_prediction_narrative(context: dict) -> str:
    """Generate a natural-language prediction narrative.

    Context should include the prediction dict from DropPredictor.predict().
    """
    template = PROMPT_TEMPLATES["prediction_narrative"]

    prompt = (
        f"{template['instruction']}\n\n"
        f"## Prediction Data\n"
        f"```json\n{json.dumps(context, indent=2, default=str)}\n```"
    )

    result = await call_llm(prompt, max_tokens=300)
    if result:
        return result

    # Fallback
    confidence = int(context.get("confidence", 0) * 100)
    day = context.get("day_of_week", "Unknown")
    time_range = context.get("time_range", "Unknown")
    reasons = context.get("reasoning", [])
    reasoning_text = reasons[0] if reasons else "Based on historical patterns."

    return template["fallback"].format(
        day_of_week=day,
        time_range=time_range,
        confidence=confidence,
        reasoning=reasoning_text,
    )


def is_configured() -> bool:
    """Check if any LLM provider is configured."""
    return bool(ANTHROPIC_API_KEY or OPENAI_API_KEY)
