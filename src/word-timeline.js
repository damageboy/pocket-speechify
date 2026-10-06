// Match pocket-tts's lexical words, not tokenizer tokens or whitespace words.
// Verify both index and spelling, as upstream's WordReadAlong does: ambiguous
// normalization must not highlight a different word on the page.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-‐‑'’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

export function createWordTimeline(text, wordOffset = 0, { inputLatency = 0, outputLatency = 0 } = {}) {
  const pageWords = [...text.matchAll(/\S+/g)];
  // Streaming strips explicit pauses. Mask with equal-length spaces so the
  // lexical sequence matches upstream while DOM offsets remain unchanged.
  const source = text.replace(/\[pause:\d+(?:\.\d+)?(?:ms|s)\]/g, marker => ' '.repeat(marker.length));
  let pageIndex = 0;
  const words = [...source.matchAll(WORD)].map(match => {
    while (pageIndex + 1 < pageWords.length && pageWords[pageIndex + 1].index <= match.index) pageIndex++;
    return { word: match[0], wordIndex: wordOffset + pageIndex };
  });
  const timings = new Map();
  const audio = [];
  let sourceEnd = 0;
  let outputEnd = 0;

  return {
    addEvents(events) {
      for (const event of events) timings.set(event.word_index, event);
    },

    // Keep the source-PCM clock separate from AudioContext time. Each chunk may
    // have a different stretch ratio, and gaps between chunks are not speech.
    addAudio(duration, startTime, endTime) {
      audio.push({ sourceStart: sourceEnd, outputStart: outputEnd, duration, startTime, endTime });
      sourceEnd += duration;
      outputEnd += endTime - startTime;
    },

    wordAt(contextTime) {
      const playing = audio.find(chunk => contextTime >= chunk.startTime && contextTime < chunk.endTime);
      if (!playing) return null;
      // Signalsmith's processing centre: source = F(output - Lo) - Li.
      // F uses actual input/output lengths, including changes of speed.
      const outputTime = playing.outputStart + contextTime - playing.startTime - outputLatency;
      if (outputTime < 0) return null;
      const chunk = audio.findLast(chunk => chunk.outputStart <= outputTime);
      const time = chunk.sourceStart + chunk.duration *
        (outputTime - chunk.outputStart) / (chunk.endTime - chunk.startTime) - inputLatency;
      let latest = null;
      for (const event of timings.values()) {
        if (event.start_time <= time && (!latest || event.start_time >= latest.start_time)) latest = event;
      }
      if (!latest || (latest.kind === 'word_end' && time >= latest.end_time)) return null;
      const word = words[latest.word_index];
      return word?.word === latest.word ? word : null;
    },
  };
}
