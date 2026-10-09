"""
Step 11 of the OutTheGC build: turn a TikTok caption (+ hashtags) into
structured place candidates with an LLM.

This is the "extract" stage of the pipeline described in OutTheGC-spec.md:
    gather (caption/hashtags via oEmbed, step 10) -> extract (this file) ->
    resolve (Google Places, step 12) -> write post_candidates -> set
    posts.status.

Provider: OpenAI (see docs/decisions/0001-openai-for-extraction.md), model
gpt-5.4-mini (confirmed reachable by test_openai_connection.py).

Structured Outputs: OpenAI's JSON Schema mode -- the API itself enforces
that the response matches a schema (here, derived from the Pydantic models
below via the SDK's `chat.completions.parse()` helper), instead of just
asking nicely in the prompt and hoping `json.loads()` doesn't throw. If the
model's draft output doesn't fit the schema, the SDK retries internally
against the constrained decoding before returning -- we still handle the
rare `refusal` / length-cutoff cases explicitly below rather than assuming
`.parsed` is always populated.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional

from dotenv import load_dotenv
from openai import (
    APIConnectionError,
    AuthenticationError,
    LengthFinishReasonError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, Field

MODEL = "gpt-5.4-mini"

# Bounded retry policy (CLAUDE.md: "Retries are explicit and bounded"). Only
# for genuinely transient failures (a dropped connection, a per-minute rate
# limit) -- never for a malformed response or a daily-quota wall, where
# retrying just burns more calls for the same outcome.
MAX_TRANSIENT_RETRIES = 2
RETRY_BACKOFF_SECONDS = [3, 9]

# Hard confidence floor, applied in code after the model responds -- not
# just as a prompt instruction. A prompt can ask the model to withhold a
# guess it would itself rate under ~0.5 (see SYSTEM_PROMPT), but a model's
# self-reported confidence isn't something to trust blindly as the only
# safeguard: this is a second, code-level check that holds regardless of
# whether the model's own self-rating is honest on a given call. The
# product's UX already treats confidence as "how sure are we" before a
# user ever sees a candidate (CLAUDE.md: confidence and multiple
# candidates are real product behavior) -- a sub-floor guess arguably
# shouldn't reach that screen at all.
#
# 0.55, not 0.5: chosen from the v2 eval run's actual confidence spread,
# not a round-number guess. The two hallucination regressions this is
# meant to catch scored 0.35 and 0.51; the next-lowest score in the whole
# 37-case run was 0.61, a genuinely correct extraction ("Puerco Pina",
# case 022). 0.55 sits in that gap -- it catches both known-bad low
# scores without clipping the lowest-known-good one. Revisit this number
# if the eval set grows and a legitimate case scores between 0.5 and 0.6.
MIN_CONFIDENCE = 0.55


# ---------------------------------------------------------------------------
# Output schema. category is a Python Enum of exactly the 7 Postgres enum
# values from step 8's migration (trip_places.category) -- passing an Enum
# as a Pydantic field type makes the SDK emit a JSON Schema `enum` constraint
# on that field, so the API can't return an 8th value even if the model
# "wants" to.
# ---------------------------------------------------------------------------


class Category(str, Enum):
    food = "food"
    views = "views"
    entertainment = "entertainment"
    stay = "stay"
    shopping = "shopping"
    nightlife = "nightlife"
    other = "other"


class ExtractedPlace(BaseModel):
    name: Optional[str] = Field(
        description=(
            "The place's proper name, written out the way it would appear "
            "on a sign or a Google Maps listing (reconstruct spacing/"
            "capitalization from a hashtag or @handle if that's the only "
            "place the name appears -- don't just copy the raw hashtag "
            "text). Set to null ONLY when a specific, distinct real-world "
            "place is clearly being pointed at (it has its own address or "
            "a precise, non-generic location) but truly no name appears "
            "anywhere in the caption, hashtags, or handles."
        )
    )
    area: Optional[str] = Field(
        description=(
            "Neighborhood, city, and/or country, in the caption's own "
            "words or a reasonable inference from context. Null if "
            "nothing about location can be inferred at all."
        )
    )
    category: Category = Field(
        description=(
            "Exactly one of the 7 allowed values. Use 'views' for scenic "
            "lookouts, nature, trails, and landmarks; 'stay' for lodging; "
            "'other' only when none of the other 6 genuinely fit."
        )
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description=(
            "Calibrated belief (0-1) that this is a real, findable place "
            "worth showing the user. A low-signal guess should get a low "
            "score, not be dressed up as certain -- the app always makes "
            "the user confirm before saving, so a lower-confidence "
            "candidate is fine to surface, just not fine to mislabel."
        ),
    )


class ExtractionResult(BaseModel):
    places: List[ExtractedPlace]


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------
#
# Design notes (see handback report for how this was tuned against the eval
# set):
#   - Zero-place captions are the default, not the exception, for vague
#     "hidden gem" hype with no identifying name -- the prompt tells the
#     model explicitly not to invent a name to fill the slot.
#   - Multi-place captions (numbered lists, pin-emoji bullets) should
#     produce one entry per distinct place, not one merged entry.
#   - A name can live in plain text, a pin-emoji address line, a stylized
#     hashtag, or an @handle -- the model has to reconstruct a readable
#     name from any of those, not just the first one it notices.
#   - A place mentioned only to dismiss it ("X is overrated") is not a
#     recommendation and should not be extracted.
#   - Non-English/bilingual captions are expected; keep the name as given,
#     still pick one of the 7 English category values.

SYSTEM_PROMPT = """You extract real-world places that a TikTok caption is \
actually recommending or featuring, for a trip-planning app. The user will \
see every place you return and manually confirm or reject it -- so it is \
far better to return nothing than to invent something.

Return a list of places (it can be empty). For each place, give:
- name: the place's real name, written out normally. It may come from the \
caption's own text, a pin-emoji ("\U0001F4CD") address/name line, a stylized \
hashtag (e.g. "#hekkelun" -> "Hekkelun", "#pohgadingwaterfall" -> "Poh \
Gading Waterfall"), or an @handle that encodes a business name (e.g. \
"@jonnyspizzanyc" -> "Jonny's Pizza"). Reconstruct normal spacing and \
capitalization -- never return the raw hashtag or handle text as-is.
- area: neighborhood/city/country, from the caption or a reasonable \
inference.
- category: exactly one of food, views, entertainment, stay, shopping, \
nightlife, other.
- confidence: 0 to 1, how sure you are this is a real, findable place.

Rules:
1. Do NOT invent a name. If the caption only has vague hype ("this hidden \
gem", "this viral restaurant", "save this spot") with no name, no \
hashtag that encodes a name, no handle, and no address -- return nothing \
for that caption. A vague caption with zero real places is the CORRECT \
answer in that case, not a failure to try harder. This includes a \
capitalized or Title-Cased generic phrase -- TikTok captions routinely \
capitalize ordinary descriptive words for emphasis ("this hidden Rooftop \
Bar", "the BEST Hidden Gem"), and that styling is NOT a signal of a real \
name (rule 4's "trust the explicit text name, especially if capitalized" \
is about an actual proper name/brand appearing in the text, not about \
capitalization itself). A real name has some distinguishing word beyond \
the generic category description -- a brand, a person's name, a \
nickname, a place-specific word. "Rooftop Bar" alone, however it's \
capitalized, is a category description of an unnamed place, not a name; \
"ICON Bar & Rooftop" is a name, because "ICON" is the distinguishing \
part. When all you have is the generic category phrase with no \
distinguishing word, that's still rule 1's no-name case -- return nothing \
(or, if a genuine address is also given, see rule 2 -- but the generic \
phrase itself never counts as the name).
2. Exception to rule 1: if the caption gives a genuine, concrete address \
(a street name/number, coordinates, or an equally specific locator) for a \
real place, but no name appears anywhere, include it anyway with name set \
to null. This requires an actual street-level address written in the \
caption. Vivid descriptive detail is NOT an address -- a long, specific \
description of a cafe's food, vibe, decor, or booking process (distinctive \
cakes, a to-go box design, an RSVP policy) still has zero location detail \
unless an actual address/street name appears, and rule 1 applies instead: \
return nothing. Don't let how detailed or confident the description sounds \
substitute for an actual address.
3. If a place is named only to be dismissed, criticized, or called \
overrated/skip-worthy, with no positive recommendation elsewhere in the \
caption, do not include it. Only extract places being recommended or \
neutrally listed, not places mentioned only to warn people off. The \
reverse also matters: a place mentioned almost in passing or as an aside \
("didn't include X here, but it's a great spot too") is still a positive \
recommendation and SHOULD be extracted, even if it's excluded from a \
separate main numbered list in the same caption.
4. A caption may recommend zero, one, or several distinct places (a \
numbered list, pin-emoji bullets, a comma-separated list, or recommendations \
mixed into regular sentences). Return one entry per distinct place, each \
with its own category -- most food lists are all "food", but check, don't \
assume. If the caption's own text names a place explicitly (especially if \
capitalized or emphasized) and a hashtag suggests a different, conflicting \
name, trust the explicit text name -- a hashtag may be the creator's \
unrelated handle, brand tagline, or wordplay, not the place being \
recommended. Only fall back to a hashtag/handle-derived name when the \
caption's own text gives no name at all.
5. Only extract the place actually being recommended -- not the building, \
shopping complex, or broader geographic feature it happens to sit inside \
or near, unless that container is itself what's being recommended (e.g. \
"visit this whole neighborhood" IS the recommendation). If a cafe is on \
the 2nd floor of a named building, or a waterfall hike ends at a named \
resort, return the cafe or the resort -- not also a second entry for the \
building or the general geographic feature, unless the caption separately \
and clearly recommends that as its own distinct stop.
6. Category calibration for cases that are easy to get wrong:
   - A whole neighborhood or district being recommended for its general \
vibe (not one specific attraction within it) is "other", not "views".
   - A themed cafe (comic/manga cafe, cat cafe, dessert cafe) is "food" if \
it's fundamentally a place to eat/drink, even if its hook is an activity. \
A gallery, museum, or similar cultural/art space is "entertainment".
   - Food-vs-nightlife precedence, in this order: (1) If the caption's \
own words explicitly call the place a "restaurant" or "cafe" ANYWHERE -- \
even if the same caption, or the place's own proper name, ALSO contains a \
nightlife word like "bar", "rooftop", "lounge", or "club" (e.g. a \
caption reading "Hanging restaurant & bar" about a place named "Hanging \
Restaurant & Bar") -- the category is "food", full stop. The explicit \
"restaurant"/"cafe" wording always wins; it is not a soft suggestion to \
weigh against the name, and a co-occurring nightlife word does not pull \
it back to "nightlife". (2) Only if rule (1) doesn't apply -- the \
caption never calls the place a "restaurant" or "cafe" -- does a \
nightlife word matter: if the caption's words explicitly call it a \
"bar"/"lounge"/"club", or if no caption wording pins down the category \
at all but the place's own proper name contains "Bar", "Rooftop", \
"Lounge", or "Club", that's "nightlife", even if the caption's hype is \
about the view, not the drinks.
7. Captions are sometimes non-English or bilingual (Spanish, German, \
Korean, Indonesian, etc). Keep the place name in whatever language/script \
it's given in (romanization in parentheses is fine to keep too); still \
pick one of the 7 English category values based on what the place \
actually is.
8. Never fabricate an address, neighborhood, or area beyond what the \
caption plus ordinary, clearly-grounded world knowledge supports (e.g. \
recognizing a well-known place's real neighborhood is fine; guessing one \
for a place you don't actually recognize is not -- leave area null \
instead).

A few examples of correct behavior:
- Caption only says "the best hidden gem cafe, save this for later" with \
hashtags like #cafe #hiddengem and nothing else identifying -> return an \
empty list. There is no name here to extract (rule 1 -- note there's no \
address either, so rule 2's exception doesn't apply).
- Caption vividly describes a "hidden gem Tokyo cafe" serving themed \
cakes, mentions an RSVP policy and a to-go box design, but gives no \
street address and no business name anywhere -> return an empty list. \
The description is detailed, but detail about food/vibe is not an \
address (rule 2's exception still does not apply) and there is no name \
(rule 1).
- Caption says "cafe onion is overrated, going somewhere better this \
time" -> do not extract "cafe onion" (rule 3); if nowhere else in the \
caption recommends an actual place, return an empty list.
- Caption gives a street address and describes a gallery's art, but no \
business name anywhere -> return one entry with name null, the area \
from the address, category "entertainment" (rules 2 and 6).
- Caption says "went to RuRu Shibuya, on the 2nd floor of Shibuya Sakura \
Stage" -> return one entry for "RuRu Shibuya" only; do not also return a \
second entry for "Shibuya Sakura Stage" (rule 5).
- Caption names a restaurant in all-caps in the sentence itself ("EL REY \
DEL PASTOR") but also has an unrelated hashtag that looks like another \
name (e.g. "#lagarnachaqueapapacha") -> use the explicit caption-text name, \
not the hashtag (rule 4).
- Caption says "Hanging restaurant & bar" about a place named "Hanging \
Restaurant & Bar" -> "food", not "nightlife" -- the caption's own words \
call it a restaurant, and that wins over both the "bar" word in the same \
caption and the "Bar" in the place's own name (rule 6).

One more thing on confidence: if, after applying the rules above, you'd \
honestly rate your own confidence in a candidate below roughly 0.5, you \
do not have enough to go on -- leave it out of the list entirely rather \
than returning it as a low-confidence guess. "This caption has location \
hype but nothing concrete enough to identify a specific place" is rule \
1's empty-list case, not a place to report with a hedge.
"""


def build_user_message(caption: str, hashtags: Optional[List[str]]) -> str:
    hashtags = hashtags or []
    hashtag_line = ", ".join(f"#{h}" for h in hashtags) if hashtags else "(none)"
    return f"Caption:\n{caption}\n\nHashtags:\n{hashtag_line}"


# ---------------------------------------------------------------------------
# Errors -- distinguished so a caller (the eval runner, later the worker)
# can decide what's retryable, what should fail a job outright, and what
# should stop an entire batch rather than keep hammering a wall.
# ---------------------------------------------------------------------------


class ExtractionError(Exception):
    """Base class for all extraction failures we want a clear message for."""


class TransientExtractionError(ExtractionError):
    """Safe to retry with backoff: a dropped connection, a per-minute rate
    limit. Not safe to retry forever -- see MAX_TRANSIENT_RETRIES."""


class QuotaExhaustedError(ExtractionError):
    """The account's daily request cap (or billing quota) is out, not a
    per-minute throttle. Retrying won't help until the quota window resets
    -- the caller should stop the whole batch, not keep spending attempts."""


class MalformedResponseError(ExtractionError):
    """The model refused, got cut off before finishing the JSON, or
    otherwise didn't give us a valid ExtractionResult. Bad-input-shaped,
    not transient -- per CLAUDE.md, fail fast rather than retry pointlessly."""


@dataclass
class Usage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass
class ExtractionCallResult:
    places: List[ExtractedPlace] = field(default_factory=list)
    usage: Optional[Usage] = None
    model: str = MODEL
    # Places the model returned but that were dropped by the MIN_CONFIDENCE
    # floor before `places` above was populated. Kept separate (not just
    # silently discarded) so a caller -- the eval runner, later the worker's
    # logging -- can see when the floor actually fired, rather than that
    # being invisible. NOTE: this means `.places` is not strictly "the
    # model's raw output" anymore for eval-scoring purposes -- it's the
    # model's output after a code-level filter. Worth being explicit about
    # that distinction since it changes what a "miss" means (a dropped
    # candidate now scores as if the model returned nothing, not as if it
    # returned something wrong).
    dropped_low_confidence: List[ExtractedPlace] = field(default_factory=list)


def _is_daily_or_quota_limit(exc: RateLimitError) -> bool:
    """The SDK raises RateLimitError for both 'too many requests per
    minute' (transient, retry) and 'per-day cap / insufficient quota'
    (not transient, stop). The error body is the only way to tell them
    apart -- same pattern as test_openai_connection.py."""
    text = str(exc).lower()
    return "insufficient_quota" in text or "quota" in text or "per day" in text or "rpd" in text


def _client() -> OpenAI:
    load_dotenv()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ExtractionError(
            "OPENAI_API_KEY is not set. Check services/worker/.env."
        )
    return OpenAI(api_key=api_key)


def extract_places(
    caption: str,
    hashtags: Optional[List[str]] = None,
    *,
    client: Optional[OpenAI] = None,
) -> ExtractionCallResult:
    """Call the LLM once for one caption and return structured places plus
    token usage. Raises a subclass of ExtractionError on any failure --
    never lets a raw SDK exception or a json parsing exception escape
    unlabeled, per the project's standing debugging rule."""
    client = client or _client()
    user_message = build_user_message(caption, hashtags)

    attempt = 0
    while True:
        try:
            completion = client.chat.completions.parse(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                response_format=ExtractionResult,
            )
            break
        except AuthenticationError as e:
            raise ExtractionError(f"Invalid/revoked API key: {e}") from e
        except RateLimitError as e:
            if _is_daily_or_quota_limit(e):
                raise QuotaExhaustedError(
                    f"Daily request cap or quota exhausted for model "
                    f"'{MODEL}': {e}"
                ) from e
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientExtractionError(
                    f"Still rate-limited (per-minute) after "
                    f"{MAX_TRANSIENT_RETRIES} retries: {e}"
                ) from e
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
        except APIConnectionError as e:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientExtractionError(
                    f"Still unable to reach OpenAI after "
                    f"{MAX_TRANSIENT_RETRIES} retries: {e}"
                ) from e
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
        except (NotFoundError, PermissionDeniedError) as e:
            raise ExtractionError(
                f"Model '{MODEL}' not available to this account/tier: {e}"
            ) from e
        except LengthFinishReasonError as e:
            raise MalformedResponseError(
                f"Response was cut off before completing the schema "
                f"(hit a token limit): {e}"
            ) from e

    choice = completion.choices[0]
    if choice.message.refusal:
        raise MalformedResponseError(
            f"Model refused to answer: {choice.message.refusal}"
        )
    parsed = choice.message.parsed
    if parsed is None:
        raise MalformedResponseError(
            "No parsed result and no refusal -- unexpected empty response."
        )

    usage = completion.usage
    usage_obj = (
        Usage(
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            total_tokens=usage.total_tokens,
        )
        if usage is not None
        else None
    )

    kept, dropped = [], []
    for p in parsed.places:
        (kept if p.confidence >= MIN_CONFIDENCE else dropped).append(p)

    return ExtractionCallResult(
        places=kept, usage=usage_obj, model=MODEL, dropped_low_confidence=dropped
    )


if __name__ == "__main__":
    # Tiny manual smoke test, not the eval runner -- `python extract.py`
    # tries one hardcoded caption so you can sanity-check the schema/prompt
    # without spending a full eval run.
    import json

    result = extract_places(
        caption=(
            "Hidden Gem in Shibuya \U0001F375✨ tucked away on the 2nd "
            "floor of Shibuya Sakura Stage is the serene RuRu Shibuya. "
            "\U0001F4CD Save this spot for your next Tokyo trip."
        ),
        hashtags=["TokyoCafe", "ShibuyaHiddenGem", "RuRuShibuya"],
    )
    print(json.dumps([p.model_dump(mode="json") for p in result.places], indent=2))
    if result.usage:
        print(f"Tokens -- total: {result.usage.total_tokens}")
