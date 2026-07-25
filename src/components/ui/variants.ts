/**
 * Local variant → className helper (no cva / tailwind-merge).
 *
 * maps props to class names: variants(base, { variant: {...}, size: {...} }, defaults)
 * returns a function of props. Unknown keys are ignored.
 */
export type VariantMap = Record<string, Record<string, string>>;

export function variants<T extends VariantMap>(
  base: string,
  config: T,
  defaults: { [K in keyof T]?: keyof T[K] & string } = {},
): (props?: { [K in keyof T]?: keyof T[K] & string } & { className?: string }) => string {
  return (props = {}) => {
    const classes = [base];
    for (const key of Object.keys(config) as Array<keyof T & string>) {
      const value = (props[key] ?? defaults[key]) as string | undefined;
      if (value == null) continue;
      const mapped = config[key]?.[value];
      if (mapped) classes.push(mapped);
    }
    if (props.className) classes.push(props.className);
    return classes.filter(Boolean).join(" ");
  };
}
