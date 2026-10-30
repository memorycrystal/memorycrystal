import type { QueryCtx } from "../_generated/server";

/** A fresh read-through cache for one Convex execution, never a module-level cache.
 * Query results seed point lookups too. Writes invalidate query results and update
 * point lookups so deleting a parent immediately exposes captured-parent fallback.
 */
export function purgeReadContext<T extends QueryCtx>(ctx: T): T {
  const documents = new Map<string, Promise<any>>();
  const queries = new Map<string, Promise<any>>();
  const seed = (rows: any) => {
    for (const row of Array.isArray(rows) ? rows : rows ? [rows] : [])
      if (row?._id) documents.set(row._id, Promise.resolve(row));
    return rows;
  };
  // Explicit structural keys include bound values, not callback source text.
  const rangeKey = (callback: any) => {
    const terms: any[] = [];
    const range: any = new Proxy(
      {},
      {
        get:
          (_object, method) =>
          (...args: any[]) => {
            terms.push([
              method,
              ...args.map((arg) =>
                arg === undefined ? ["undefined"] : ["value", arg],
              ),
            ]);
            return range;
          },
      },
    );
    callback(range);
    return terms;
  };
  const query = (source: any, key: any[], cacheable = true): any =>
    new Proxy(source, {
      get(object, property) {
        const value = object[property];
        if (
          ["first", "unique", "take", "collect", "paginate"].includes(
            String(property),
          )
        )
          return (...args: any[]) => {
            const read = async () => {
              const result = await value.apply(object, args);
              seed(property === "paginate" ? result.page : result);
              return result;
            };
            // Cursors are consumed only once; filters can contain arbitrary expressions.
            if (
              !cacheable ||
              property === "paginate" ||
              args.some((arg) => typeof arg === "function")
            )
              return read();
            const signature = JSON.stringify([...key, property, args]);
            if (!queries.has(signature)) queries.set(signature, read());
            return queries.get(signature)!;
          };
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const next = value.apply(object, args);
          if (!next?.take) return next;
          const term =
            property === "withIndex"
              ? [property, args[0], args[1] ? rangeKey(args[1]) : []]
              : [property, ...args];
          return query(
            next,
            [...key, term],
            cacheable &&
              !args.some(
                (arg, index) =>
                  typeof arg === "function" &&
                  !(property === "withIndex" && index === 1),
              ),
          );
        };
      },
    });
  const db = new Proxy(ctx.db, {
    get(object, property) {
      if (property === "get")
        return (id: any) => {
          if (!documents.has(id)) documents.set(id, object.get(id));
          return documents.get(id)!;
        };
      if (property === "query")
        return (table: any) => query(object.query(table), [table]);
      const value = (object as any)[property];
      if (["delete", "patch", "replace", "insert"].includes(String(property)))
        return async (...args: any[]) => {
          const result = await value.apply(object, args);
          queries.clear();
          if (property === "delete")
            documents.set(args[0], Promise.resolve(null));
          else if (property === "patch" && documents.has(args[0])) {
            const before = await documents.get(args[0]);
            documents.set(
              args[0],
              Promise.resolve(before ? { ...before, ...args[1] } : null),
            );
          } else if (property === "replace" && documents.has(args[0])) {
            const before = await documents.get(args[0]);
            documents.set(
              args[0],
              Promise.resolve(
                before
                  ? {
                      ...args[1],
                      _id: before._id,
                      _creationTime: before._creationTime,
                    }
                  : null,
              ),
            );
          }
          return result;
        };
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { ...ctx, db };
}
