const { truncateMemoryContent, KB_MAX_CHARS, NON_KB_MAX_CHARS } = require("./memory-formatter");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} — ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

console.log("memory-formatter tests:");

test("constants are 1200 KB / 600 non-KB", () => {
  assert(KB_MAX_CHARS === 1200, `expected 1200, got ${KB_MAX_CHARS}`);
  assert(NON_KB_MAX_CHARS === 600, `expected 600, got ${NON_KB_MAX_CHARS}`);
});

test("non-KB memory at 1000 chars caps to <= 600 chars", () => {
  const content = ("This is a sentence. ").repeat(100); // 2000 chars, ends in period
  const result = truncateMemoryContent(content, false);
  assert(result.length <= NON_KB_MAX_CHARS, `expected <= 600, got ${result.length}`);
});

test("KB memory at 1000 chars is unchanged (under cap)", () => {
  const content = "x".repeat(1000);
  const result = truncateMemoryContent(content, true);
  assert(result === content, `expected unchanged, got length ${result.length}`);
});

test("KB memory at 2000 chars caps to <= 1200 chars", () => {
  const content = ("This is a sentence. ").repeat(150); // 3000 chars
  const result = truncateMemoryContent(content, true);
  assert(result.length <= KB_MAX_CHARS, `expected <= 1200, got ${result.length}`);
});

test("non-KB content under 600 chars is returned unchanged", () => {
  const content = "Short note. Just a few words.";
  const result = truncateMemoryContent(content, false);
  assert(result === content, "should return unchanged");
});

test("sentence-boundary slicing: result ends at . ! ? or paragraph break", () => {
  const sentences = [
    "First sentence about something. ",
    "Second sentence with more detail. ",
    "Third sentence asks a question? ",
    "Fourth sentence ends emphatically! ",
    "Fifth sentence keeps going on and on with verbose phrasing. ",
    "Sixth sentence concludes the paragraph idea. ",
  ];
  // Build a long KB excerpt that exceeds 1200 chars
  const text = sentences.join("").repeat(10);
  const result = truncateMemoryContent(text, true);
  assert(result.length <= KB_MAX_CHARS, `expected <= 1200, got ${result.length}`);
  const last = result[result.length - 1];
  assert([".", "!", "?", "\n"].includes(last), `expected sentence terminator, got '${last}'`);
});

test("paragraph-break boundary preferred when present in window", () => {
  const text = "First paragraph here without terminator only words and words and more words and more words and more\n\nSecond paragraph also long and detailed running on and on past the cap " + "x".repeat(800);
  const result = truncateMemoryContent(text, true);
  assert(result.length <= KB_MAX_CHARS, `expected <= 1200, got ${result.length}`);
  // The paragraph break should be preserved as a valid cut.
  assert(result.includes("\n\n") || result.endsWith("."), "should cut at paragraph break or sentence");
});

test("10 KB excerpts (multi-sentence) post-cap have zero ending mid-sentence", () => {
  // 10 realistic-shaped KB excerpts, each 800-2000 chars, each multi-sentence.
  const excerpts = [
    "A Half Rap is the first 'T' in STAT on steroids. You are not happy wife happy life-ing it. You allow her to run you off the track but you keep driving your line. " + "Detail sentence ".repeat(80),
    "The Gottman Sound Relationship House describes seven layers from love maps at the base up to creating shared meaning at the top. " + "Each layer builds on the previous. ".repeat(40),
    "Repair attempts are bids to de-escalate conflict. They can be verbal or non-verbal. Successful couples accept repair attempts at higher rates than distressed couples. " + "More content here. ".repeat(60),
    "STAT stands for Slow down, Tune in, Acknowledge, and Take responsibility. It is a four-step intervention. " + "Used after major conflicts. ".repeat(50),
    "Bids for connection are small attempts to engage. Examples include comments, questions, or touches. Turning toward bids strengthens relationships. " + "Turning away erodes them. ".repeat(45),
    "The Four Horsemen are criticism, contempt, defensiveness, and stonewalling. Contempt is the strongest predictor of divorce. " + "Antidotes exist for each. ".repeat(55),
    "Emotional flooding is when physiological arousal exceeds 100 BPM during conflict. Productive conversation becomes impossible. Take a 20-minute break minimum. " + "Self-soothe before returning. ".repeat(35),
    "Love languages framework includes words of affirmation, acts of service, gifts, quality time, and physical touch. Partners often differ. " + "Identify your primary. ".repeat(50),
    "Differentiation in marriage is the ability to maintain a sense of self while staying connected. Bowen called it self-differentiation. " + "Critical for long-term stability. ".repeat(40),
    "Attachment styles - secure, anxious, avoidant, disorganized - shape adult relationship patterns. They form in early childhood. " + "Earned secure is achievable. ".repeat(45),
  ];
  let midSentenceCount = 0;
  for (const text of excerpts) {
    const result = truncateMemoryContent(text, true);
    if (result.length === text.length) continue; // wasn't truncated
    const last = result[result.length - 1];
    if (![".", "!", "?", "\n"].includes(last)) midSentenceCount++;
  }
  assert(midSentenceCount === 0, `${midSentenceCount}/10 KB excerpts ended mid-sentence`);
});

test("hard slice fallback when no sentence boundary inside window", () => {
  const noBoundaries = "x".repeat(2000); // no . ! ? or \n\n
  const result = truncateMemoryContent(noBoundaries, true);
  assert(result.length === KB_MAX_CHARS, `expected hard slice to ${KB_MAX_CHARS}, got ${result.length}`);
});

test("non-KB sentence boundary slicing", () => {
  const text = ("Note one. Note two. Note three. ").repeat(50); // 1600 chars
  const result = truncateMemoryContent(text, false);
  assert(result.length <= NON_KB_MAX_CHARS, `expected <= 600, got ${result.length}`);
  const last = result[result.length - 1];
  assert([".", "!", "?"].includes(last), `expected sentence terminator, got '${last}'`);
});

test("null and undefined content return empty string", () => {
  assert(truncateMemoryContent(null, true) === "", "null → ''");
  assert(truncateMemoryContent(undefined, false) === "", "undefined → ''");
  assert(truncateMemoryContent("", true) === "", "'' → ''");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
