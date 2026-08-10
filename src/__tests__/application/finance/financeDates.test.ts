import {
  isRealAnnulment,
  grDateTimeDatePart,
  arYearMonth,
  grDateAr,
  previousYearMonth,
  compareYearMonth,
  yearMonthToGrRange,
  yearMonthToDateRange,
  isValidYearMonth,
  isValidGrDate,
  GR_NULL_DATE_SENTINEL,
  addCalendarMonthsToDate,
  assertYearMonthRangeWidth,
} from '@application/use-cases/finance/financeDates';
import { FinanceValidationError } from '@domain/errors/finance';

describe('financeDates', () => {
  describe('isRealAnnulment', () => {
    it('is false for the GR null-date centinela', () => {
      expect(isRealAnnulment(GR_NULL_DATE_SENTINEL)).toBe(false);
    });
    it('is false for missing/empty/null', () => {
      expect(isRealAnnulment(null)).toBe(false);
      expect(isRealAnnulment(undefined)).toBe(false);
      expect(isRealAnnulment('')).toBe(false);
      expect(isRealAnnulment('   ')).toBe(false);
    });
    it('is true for any other non-empty date string', () => {
      expect(isRealAnnulment('15-06-2026 10:00:00')).toBe(true);
    });

    // F10 — fail-OPEN: the ORIGINAL implementation was fail-CLOSED (anything
    // non-empty and not the EXACT centinela string counted as a real
    // annulment). Any all-zeros sentinel variant — different width, separator,
    // spacing, or field order — must ALSO mean "not annulled". Only a
    // genuinely parseable, non-zero calendar date proves a real annulment.
    it('F10: is false for the date-only centinela without a time component ("00-00-0000")', () => {
      expect(isRealAnnulment('00-00-0000')).toBe(false);
    });

    it('F10: is false for the reversed YYYY-MM-DD all-zeros form ("0000-00-00 00:00:00")', () => {
      expect(isRealAnnulment('0000-00-00 00:00:00')).toBe(false);
    });

    it('F10: is false for the reversed date-only all-zeros form ("0000-00-00")', () => {
      expect(isRealAnnulment('0000-00-00')).toBe(false);
    });

    it('F10: is false for an all-zeros date with a double space before the time', () => {
      expect(isRealAnnulment('00-00-0000  00:00:00')).toBe(false);
    });

    it('F10: is false for an all-zeros date with slash separators', () => {
      expect(isRealAnnulment('00/00/0000')).toBe(false);
    });

    it('F10: a real, valid, non-zero annulment date still counts as annulled', () => {
      expect(isRealAnnulment('20-06-2026')).toBe(true);
      expect(isRealAnnulment('20-06-2026 12:00:00')).toBe(true);
    });

    // ── gr-receipt-annulment (design.md Decision 5) — three layers on top of
    // F10: (1) accept ISO as a SECOND valid non-annulled format, (2) flip the
    // residual fail-OPEN direction to fail-CLOSED PER ROW (residue that is
    // non-empty, non-centinela, and unparseable in EITHER format now counts
    // as annulled — "GR no llena ese campo por gusto"), (3) a systemic guard
    // over the whole page (financeAnnulmentGuard, Fase 3) for when the
    // residue stops being residue (a centinela format drift). The two tests
    // deleted here ("genuinely unparseable garbage is NOT proof" / "out-of-
    // range non-zero date is NOT proof") pinned the OLD fail-open behavior —
    // superseded below, not silently dropped.
    // ── sdd-verify NOTE (spec/design conflict, resolved per design.md) ──
    // `specs/finance-growth/spec.md`'s "ISO-formatted fecha_anulacion..."
    // scenario says `THEN devuelve false`, but its OWN "(Previously: ...
    // isRealAnnulment('2026-06-15 10:00:00') devolvía false)" note describes
    // that EXACT SAME return value as the bug being fixed — i.e. the spec
    // scenario, read literally, asserts NO behavior change at all. design.md
    // Decision 5's table is explicit and internally consistent: this ISO row
    // is marked `Hoy: false ⚠️ | Nuevo: true` and is one of the "tres filas
    // marcadas ⚠️ son las que hoy contarían plata anulada como cobrada en
    // silencio" — the whole point of the fix. Implemented per design.md
    // (true = genuinely annulled); flagged for sdd-verify to fix the spec text.
    describe('gr-receipt-annulment: ISO accepted as a second valid annulment-date format (design.md Decision 5 — see spec-conflict note above)', () => {
      it('a real ISO annulment date with a time component is recognized as annulled, WITHOUT a warning', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // This is the EXACT value that pinned the fail-open bug at the old
        // financeDates.test.ts:86 ("ISO -> false" was the OLD, WRONG behavior
        // this rewrite closes — a real ISO annulment silently counted as cash).
        expect(isRealAnnulment('2026-06-15 10:00:00')).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('a date-only ISO value ("2026-06-15") is also recognized as annulled', () => {
        expect(isRealAnnulment('2026-06-15')).toBe(true);
      });

      it('the all-zeros ISO-shaped sentinel ("0000-00-00 00:00:00") is STILL the known-good sentinel, not misread as an ISO date', () => {
        expect(isRealAnnulment('0000-00-00 00:00:00')).toBe(false);
      });

      it('a real ISO annulment date (a genuine drift-to-ISO scenario) counts as annulled', () => {
        expect(isRealAnnulment('2026-06-20 12:00:00')).toBe(true);
        expect(isRealAnnulment('2026-06-20')).toBe(true);
      });
    });

    describe('gr-receipt-annulment: unparseable residue now marks the ROW as annulled (scenario 19), never the whole page', () => {
      let warnSpy: jest.SpyInstance;
      beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
      afterEach(() => warnSpy.mockRestore());

      it('a genuinely unparseable garbage string ("basura"/"N/A"/"-") counts as annulled, with a warning', () => {
        expect(isRealAnnulment('not-a-date')).toBe(true);
        expect(isRealAnnulment('N/A')).toBe(true);
        expect(isRealAnnulment('-')).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('scenario 19 fixture — "nota de credito" counts as annulled, with a warning', () => {
        expect(isRealAnnulment('nota de credito')).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/nota de credito.*ANULADO/));
      });

      it('an out-of-range DD-MM-YYYY ("32-13-2026") counts as annulled, with a warning', () => {
        expect(isRealAnnulment('32-13-2026')).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('an out-of-range ISO date ("2026-13-45") counts as annulled, with a warning', () => {
        expect(isRealAnnulment('2026-13-45')).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('a value with too many date-like components ("2026-2026-2026") counts as annulled, with a warning', () => {
        expect(isRealAnnulment('2026-2026-2026')).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('includes the receipt key in the warning when provided, for triage', () => {
        isRealAnnulment('not-a-date', '9001');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('receipt 9001'));
      });

      it('the warning message now says "tratado como ANULADO", not "NOT annulled" (fail-open language is gone)', () => {
        isRealAnnulment('basura');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/ANULADO/));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/NOT annulled/));
      });

      it('does NOT warn for the known-good all-zeros sentinel (any separator/spacing/format)', () => {
        isRealAnnulment(GR_NULL_DATE_SENTINEL);
        isRealAnnulment('0000-00-00 00:00:00');
        isRealAnnulment('00/00/0000');
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('does NOT warn for a real, valid, parseable annulment date (DD-MM-YYYY or ISO)', () => {
        isRealAnnulment('20-06-2026');
        isRealAnnulment('2026-06-20');
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('does NOT warn for empty/missing values', () => {
        isRealAnnulment(null);
        isRealAnnulment(undefined);
        isRealAnnulment('');
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('grDateTimeDatePart', () => {
    it('strips the time component', () => {
      expect(grDateTimeDatePart('15-06-2026 10:00:00')).toBe('15-06-2026');
    });
    it('returns null for missing input', () => {
      expect(grDateTimeDatePart(null)).toBeNull();
      expect(grDateTimeDatePart('')).toBeNull();
    });
  });

  describe('arYearMonth', () => {
    it('formats a date to YYYY-MM in Argentina time', () => {
      expect(arYearMonth(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06');
    });
    it('rolls back a day for the late-UTC-night AR window', () => {
      // 2026-06-01T02:00:00Z is 2026-05-31 23:00 in AR (UTC-3) — still May.
      expect(arYearMonth(new Date('2026-06-01T02:00:00Z'))).toBe('2026-05');
    });
  });

  describe('grDateAr', () => {
    it('formats as DD-MM-AAAA', () => {
      expect(grDateAr(new Date('2026-06-05T12:00:00Z'))).toBe('05-06-2026');
    });
  });

  describe('previousYearMonth', () => {
    it('steps back one month within a year', () => {
      expect(previousYearMonth('2026-06')).toBe('2026-05');
    });
    it('rolls back across a year boundary', () => {
      expect(previousYearMonth('2026-01')).toBe('2025-12');
    });
  });

  describe('compareYearMonth', () => {
    it('orders lexicographically (safe for zero-padded YYYY-MM)', () => {
      expect(compareYearMonth('2025-12', '2026-01')).toBeLessThan(0);
      expect(compareYearMonth('2026-01', '2026-01')).toBe(0);
      expect(compareYearMonth('2026-02', '2026-01')).toBeGreaterThan(0);
    });
  });

  describe('yearMonthToGrRange', () => {
    it('covers the whole calendar month', () => {
      expect(yearMonthToGrRange('2026-06')).toEqual({ fechaDesde: '01-06-2026', fechaHasta: '30-06-2026' });
    });
    it('handles February in a leap year', () => {
      expect(yearMonthToGrRange('2024-02')).toEqual({ fechaDesde: '01-02-2024', fechaHasta: '29-02-2024' });
    });
  });

  // F14 — cursor-shape guards. A cursor written by an OLDER convention or
  // corrupted by hand must never be blindly trusted by `lastIndexOf`/`split`
  // arithmetic — that produced "2026-0" out of a flat "2026-03" heir cursor,
  // which then built "01-00-2026" and looped forever on GR errors.
  describe('isValidYearMonth', () => {
    it('accepts a well-formed "YYYY-MM"', () => {
      expect(isValidYearMonth('2026-07')).toBe(true);
      expect(isValidYearMonth('2013-01')).toBe(true);
      expect(isValidYearMonth('2026-12')).toBe(true);
    });
    it('rejects a truncated/legacy flat cursor ("2026-0")', () => {
      expect(isValidYearMonth('2026-0')).toBe(false);
    });
    it('rejects an out-of-range month', () => {
      expect(isValidYearMonth('2026-00')).toBe(false);
      expect(isValidYearMonth('2026-13')).toBe(false);
    });
    it('rejects garbage', () => {
      expect(isValidYearMonth('')).toBe(false);
      expect(isValidYearMonth('not-a-month')).toBe(false);
    });
  });

  describe('isValidGrDate', () => {
    it('accepts a well-formed "DD-MM-AAAA"', () => {
      expect(isValidGrDate('15-07-2026')).toBe(true);
    });
    it('rejects an ISO date (GR itself 500s on this, but we must never persist it either)', () => {
      expect(isValidGrDate('2026-07-15')).toBe(false);
    });
    it('rejects garbage/empty', () => {
      expect(isValidGrDate('')).toBe(false);
      expect(isValidGrDate('garbage')).toBe(false);
    });
  });

  describe('yearMonthToDateRange', () => {
    it('returns an AR-midnight-pinned [start, endExclusive) matching parseGrInvoiceDate', () => {
      const { start, endExclusive } = yearMonthToDateRange('2026-06');
      expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
      expect(endExclusive.toISOString()).toBe('2026-07-01T03:00:00.000Z');
    });
  });

  describe('addCalendarMonthsToDate (fix-wave-4 🔴4)', () => {
    it('adds whole calendar months to the REAL instant, not floored to day 1', () => {
      const d = addCalendarMonthsToDate(new Date('2026-01-15T12:00:00.000Z'), 6);
      expect(d.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    });

    it('clamps the day on a long->short month transition (Jan 31 + 1 month -> Feb 28, never Mar 3)', () => {
      const d = addCalendarMonthsToDate(new Date('2026-01-31T12:00:00.000Z'), 1);
      expect(d.toISOString()).toBe('2026-02-28T12:00:00.000Z'); // 2026 is not a leap year
    });

    it('clamps correctly across a leap-year February', () => {
      const d = addCalendarMonthsToDate(new Date('2028-01-31T12:00:00.000Z'), 1);
      expect(d.toISOString()).toBe('2028-02-29T12:00:00.000Z'); // 2028 IS a leap year
    });

    it('rolls over into the next year when the month index overflows', () => {
      const d = addCalendarMonthsToDate(new Date('2026-11-15T12:00:00.000Z'), 6);
      expect(d.toISOString()).toBe('2027-05-15T12:00:00.000Z');
    });
  });

  describe('assertYearMonthRangeWidth (fix-wave-4 🔵17)', () => {
    it('does not throw for a range at or under the 240-month (20-year) cap', () => {
      expect(() => assertYearMonthRangeWidth('2007-01', '2026-12')).not.toThrow(); // exactly 240 months
    });

    it('throws FinanceValidationError for a range wider than 240 months', () => {
      expect(() => assertYearMonthRangeWidth('1990-01', '2026-12')).toThrow(FinanceValidationError);
    });
  });
});
