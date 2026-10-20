// Clock interface (injectable for tests) and utcMonthStart(date).

export interface Clock {
    now(): Date;
}

export const systemClock: Clock = {
    now() {
        return new Date();
    },
};

// First day of the UTC month containing `date`, as 'YYYY-MM-01'. A string, not a
// Date: it matches what the DATE parser returns and avoids time zone shifts when
// passed to Postgres as a query parameter.
export function utcMonthStart(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}-01`;
}