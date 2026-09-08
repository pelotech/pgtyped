import type { QueryIR } from './ir.js';

export type Scalar = string | number | null;

export enum ParameterTransform {
  Scalar,
  Spread,
  Pick,
  PickSpread,
}

export interface ScalarParameter {
  name: string;
  type: ParameterTransform.Scalar;
  required: boolean;
  assignedIndex: number;
}

export interface DictParameter {
  name: string;
  type: ParameterTransform.Pick;
  dict: {
    [key: string]: ScalarParameter;
  };
}

export interface ScalarArrayParameter {
  name: string;
  type: ParameterTransform.Spread;
  required: boolean;
  assignedIndex: number | number[];
}

export interface DictArrayParameter {
  name: string;
  type: ParameterTransform.PickSpread;
  dict: {
    [key: string]: ScalarParameter;
  };
}

export type QueryParameter =
  ScalarParameter | ScalarArrayParameter | DictParameter | DictArrayParameter;

export interface InterpolatedQuery {
  query: string;
  mapping: QueryParameter[];
  bindings: Scalar[];
}

export interface NestedParameters {
  [subParamName: string]: Scalar;
}

export interface QueryParameters {
  [paramName: string]:
    Scalar | NestedParameters | Scalar[] | NestedParameters[];
}

/** Applies non-overlapping half-open substitutions, last first so earlier offsets stay valid. */
function substitute(
  text: string,
  intervals: { a: number; b: number; sub: string }[],
): string {
  let out = text;
  for (const { a, b, sub } of [...intervals].sort((x, y) => y.a - x.a)) {
    out = out.slice(0, a) + sub + out.slice(b);
  }
  return out;
}

/** Renders a query IR into SQL with `$n` placeholders, plus bindings or a mapping. */
export const render = (
  queryIR: QueryIR,
  passedParams?: QueryParameters,
): InterpolatedQuery => {
  const bindings: Scalar[] = [];
  const paramMapping: QueryParameter[] = [];
  let i = 1;
  const intervals: { a: number; b: number; sub: string }[] = [];
  for (const usedParam of queryIR.params) {
    // Handle spread transform
    if (usedParam.transform.type === 'array_spread') {
      let sub: string;
      if (passedParams) {
        const paramValue = passedParams[usedParam.name];
        sub = (paramValue as Scalar[])
          .map((val) => {
            bindings.push(val);
            return `$${i++}`;
          })
          .join(',');
      } else {
        const idx = i++;
        paramMapping.push({
          name: usedParam.name,
          type: ParameterTransform.Spread,
          assignedIndex: idx,
          required: usedParam.required,
        } as ScalarArrayParameter);
        sub = `$${idx}`;
      }
      usedParam.locs.forEach((loc) =>
        intervals.push({
          ...loc,
          sub: `(${sub})`,
        }),
      );
      continue;
    }

    // Handle pick transform
    if (usedParam.transform.type === 'pick_tuple') {
      const dict: {
        [key: string]: ScalarParameter;
      } = {};
      const sub = usedParam.transform.keys
        .map(({ name, required }) => {
          const idx = i++;
          dict[name] = {
            name,
            required,
            type: ParameterTransform.Scalar,
            assignedIndex: idx,
          } as ScalarParameter;
          if (passedParams) {
            const paramValue = passedParams[usedParam.name] as NestedParameters;
            const val = paramValue[name];
            bindings.push(val);
          }
          return `$${idx}`;
        })
        .join(',');
      if (!passedParams) {
        paramMapping.push({
          name: usedParam.name,
          type: ParameterTransform.Pick,
          dict,
        });
      }

      usedParam.locs.forEach((loc) =>
        intervals.push({
          ...loc,
          sub: `(${sub})`,
        }),
      );
      continue;
    }

    // Handle spreadPick transform
    if (usedParam.transform.type === 'pick_array_spread') {
      let sub: string;
      const { keys } = usedParam.transform;
      if (passedParams) {
        const passedParam = passedParams[usedParam.name] as NestedParameters[];
        sub = passedParam
          .map((entity) => {
            const ssub = keys
              .map(({ name }) => {
                const val = entity[name];
                bindings.push(val);
                return `$${i++}`;
              })
              .join(',');
            return ssub;
          })
          .join('),(');
      } else {
        const dict: {
          [key: string]: ScalarParameter;
        } = {};
        sub = keys
          .map(({ name, required }) => {
            const idx = i++;
            dict[name] = {
              name,
              required,
              type: ParameterTransform.Scalar,
              assignedIndex: idx,
            } as ScalarParameter;
            return `$${idx}`;
          })
          .join(',');
        paramMapping.push({
          name: usedParam.name,
          type: ParameterTransform.PickSpread,
          dict,
        });
      }

      usedParam.locs.forEach((loc) =>
        intervals.push({
          ...loc,
          sub: `(${sub})`,
        }),
      );
      continue;
    }

    // Handle scalar transform
    const assignedIndex = i++;
    if (passedParams) {
      const paramValue = passedParams[usedParam.name] as Scalar;
      bindings.push(paramValue);
    } else {
      paramMapping.push({
        name: usedParam.name,
        type: ParameterTransform.Scalar,
        assignedIndex,
        required: usedParam.required,
      } as ScalarParameter);
    }

    usedParam.locs.forEach((loc) =>
      intervals.push({
        ...loc,
        sub: `$${assignedIndex}`,
      }),
    );
  }
  const flatStr = substitute(queryIR.statement, intervals);
  return {
    mapping: paramMapping,
    query: flatStr,
    bindings,
  };
};
