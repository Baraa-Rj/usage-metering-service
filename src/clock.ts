// Clock interface (injectable for tests) and utcMonthStart(date).

export interface Clock {
    now(): Date;
}

export const systemClock: Clock = {
    now() {
        return new Date();
    },
};

export function utcMonthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}