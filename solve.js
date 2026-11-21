// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for the input {text, header}, but reads the
// text with bulk scans instead of one character at a time.
//
// The semantics follow csv-reader 1.0.0's written broken-row policy, which I
// re-derived from its reference code:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends: line the 1-based line its record starts on (every LF, CRLF and
//     lone CR inside a quoted field counted), row its record's index in rows
//     (null for the header).
//
// Speed comes from bulk scans, in a chunk loop per record:
//   - the plain run of fields up to the next quote (or the rest of the
//     record, when it holds no quote) is sliced and split on commas in one
//     native call, instead of being walked field by field;
//   - a quoted field is closed with indexOf, its text taken by one slice
//     (two short indexOf checks on the slice say whether it holds a line
//     break or a doubled quote, and only then is it normalised);
//   - only the rare paths — a stray CR, a quote inside an unquoted field,
//     junk after a closing quote — fall back to a regex scan that finds the
//     next of comma, quote, CR, LF one field at a time.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free ES module.

/** The next of comma, quote, CR, LF. */
const DELIM = /[",\r\n]/g;

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read by readQuoted/readUnquoted, and how many characters a junk tail added to it.
  let fval = '';
  let fadded = 0;
  // Whether the record's last field came from a quoted field (for the stray-CR-only skip).
  let lastQuoted = false;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns how the field ended; `fadded` counts the characters kept. Only the rare paths use this:
  // a stray CR, a quote inside an unquoted field, junk after a closing quote.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        // The rest of the text is plain: keep it from `start`, which a
        // literal quote inside the field never moved.
        if (start < len) {
          value += text.slice(start);
          added += len - start;
        }
        pos = len;
        fval = value;
        fadded = added;
        return END;
      }
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 44) {
        // ','
        if (i > start) {
          value += text.slice(start, i);
          added += i - start;
        }
        pos = i + 1;
        fval = value;
        fadded = added;
        return COMMA;
      }
      if (c === 10) {
        // '\n'
        if (i > start) {
          value += text.slice(start, i);
          added += i - start;
        }
        pos = i + 1;
        line += 1;
        fval = value;
        fadded = added;
        return LINE_BREAK;
      }
      if (c === 13) {
        // '\r': a line break with the LF that follows it, else a dropped stray CR.
        if (text.charCodeAt(i + 1) === 10) {
          if (i > start) {
            value += text.slice(start, i);
            added += i - start;
          }
          pos = i + 2;
          line += 1;
          fval = value;
          fadded = added;
          return LINE_BREAK;
        }
        if (i > start) {
          value += text.slice(start, i);
          added += i - start;
        }
        error('stray_cr');
        pos = i + 1;
        start = pos;
        continue;
      }
      // '"' inside an unquoted field is a literal character: keep scanning,
      // leaving `start` where it is so the slice keeps the quote.
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. `lineEndHint` is the first LF at or after the opening
  // quote when the caller already knows it, else -1 to look it up. Returns how the field ended.
  function readQuoted(lineEndHint) {
    const open = pos;
    const openLine = line;
    pos += 1;
    // The closing quote is the first quote not doubled by the one after it.
    let q = text.indexOf('"', pos);
    let escaped = false;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      escaped = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    const seg = text.slice(pos, q);
    // A line break inside the quotes is the first LF at or after the opening quote falling before the
    // closing one, or any CR in the slice.
    if (lineEndHint === undefined) lineEndHint = text.indexOf('\n', open);
    const hasBreak = (lineEndHint !== -1 && lineEndHint < q) || seg.indexOf('\r') !== -1;
    let value;
    if (!escaped && !hasBreak) {
      // The common quoted field: plain text between the quotes.
      value = seg;
    } else {
      value = seg;
      if (hasBreak) {
        // CRLF and a lone CR inside quotes are each one LF, and each counts one line.
        const breaks = seg.match(/\r\n|\r|\n/g);
        if (breaks !== null) line += breaks.length;
        value = seg.replace(/\r\n?/g, '\n');
      }
      if (escaped) value = value.replace(/""/g, '"');
    }
    pos = q + 1;
    if (pos >= len) {
      fval = value;
      fadded = 0;
      return END;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fval = value;
      fadded = 0;
      return COMMA;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fval = value;
      fadded = 0;
      return LINE_BREAK;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fval = value;
      fadded = 0;
      return LINE_BREAK;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const ended = readUnquoted(value);
    if (fadded > 0) error('quote_junk');
    return ended;
  }

  // Reads the rest of a record field by field (the rare path: a stray CR hides in the chunk). Appends to `fields`
  // and sets lastQuoted to the last field's kind.
  function readRestByRegex(fields) {
    let ended;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      ended = quoted ? readQuoted(undefined) : readUnquoted('');
      fields.push(fval);
      lastQuoted = quoted;
    } while (ended === COMMA);
  }

  // Finishes a record: the header, or a row padded or cut to the first record's width.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields = [];
    lastQuoted = false;

    // The record, chunk by chunk: each chunk is the plain run of fields up to the next quote, then that
    // quote's field; or, when no quote comes before the line break, the plain rest of the record.
    // Every scan stays inside the record's current line: the line is sliced once, and the quote and
    // stray-CR checks run on that slice, so a stretch with no quote never scans past the line.
    while (true) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? len : nl;
      const crlf = nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13;
      let end = lineEnd;
      if (crlf) end -= 1;
      const seg = text.slice(pos, end);
      const qiRel = seg.indexOf('"');
      const crRel = seg.indexOf('\r');
      if (qiRel === -1) {
        // No quote before the line break: the rest of the record is plain, modulo a stray CR.
        if (crRel === -1) {
          const tail = seg.split(',');
          if (fields.length === 0) fields = tail;
          else for (let k = 0; k < tail.length; k++) fields.push(tail[k]);
          lastQuoted = false;
          pos = nl === -1 ? len : nl + 1;
          if (nl !== -1) line += 1;
        } else {
          readRestByRegex(fields);
        }
        break;
      }
      // A quote comes before the line break: the plain run up to it, then that quote's field.
      if (crRel !== -1 && crRel < qiRel) {
        readRestByRegex(fields);
        break;
      }
      const run = seg.slice(0, qiRel);
      const parts = run.split(',');
      if (fields.length === 0) fields = parts.slice(0, -1);
      else for (let k = 0; k < parts.length - 1; k++) fields.push(parts[k]);
      const prefix = parts[parts.length - 1];
      const qi = pos + qiRel;
      let ended;
      if (qiRel === 0 || run.charCodeAt(run.length - 1) === 44) {
        // The quote opens a field.
        pos = qi;
        ended = readQuoted(nl);
        fields.push(fval);
        lastQuoted = true;
      } else {
        // The quote sits inside an unquoted field: a literal character.
        pos = qi + 1;
        ended = readUnquoted(prefix + '"');
        fields.push(fval);
        lastQuoted = false;
      }
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
