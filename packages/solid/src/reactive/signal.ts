// Inspired by S.js by Adam Haile, https://github.com/adamhaile/S

import { requestCallback, Task } from "./scheduler.js";
import { setHydrateContext, sharedConfig } from "../render/hydration.js";
import type { JSX } from "../jsx.js";
import type { FlowComponent, FlowProps } from "../render/index.js";

export const equalFn = <T>(a: T, b: T) => a === b;
export const $PROXY = Symbol("solid-proxy");
export const $TRACK = Symbol("solid-track");
export const $DEVCOMP = Symbol("solid-dev-component");
const signalOptions = { equals: equalFn };
let ERROR: symbol | null = null;
let runEffects = runQueue;
const CLEAN = 0;
const STALE = 1;
const PENDING = 2;
const UNOWNED: Owner = {
  owned: null,
  cleanups: null,
  context: null,
  owner: null
};
const NO_INIT = {};
export var Owner: Owner | null = null;
export let Transition: TransitionState | null = null;
let Scheduler: ((fn: () => void) => any) | null = null;
let ExternalSourceFactory: ExternalSourceFactory | null = null;
let Listener: Computation<any> | null = null;
let Effects: Computation<any>[] | null = null;
let CurrentGets: SignalState<any>[] | null = null;
let CurrentGetsIndex = 0;
let rootCount = 0;

// keep immediately evaluated module code, below its indirect declared let dependencies like Listener
const [transPending, setTransPending] = /*@__PURE__*/ createSignal(false);

declare global {
  var _$afterUpdate: (() => void) | undefined;
  var _$afterCreateRoot: ((root: Owner) => void) | undefined;
}

export interface SignalState<T> {
  value?: T;
  observers: Computation<any>[] | null;
  comparator?: (prev: T, next: T) => boolean;
  name?: string;
}

export interface Owner {
  owned: Computation<any>[] | null;
  cleanups: (() => void)[] | null;
  owner: Owner | null;
  context: any | null;
  sourceMap?: Record<string, { value: unknown }>;
  name?: string;
  componentName?: string;
}

export interface Computation<Init, Next extends Init = Init> extends Owner {
  fn: EffectFunction<Init, Next>;
  state: number;
  sources: SignalState<Next>[] | null;
  value?: Init;
  effect: boolean;
  user?: boolean;
  suspense?: SuspenseContextType;
}

export interface TransitionState {
  sources: Map<SignalState<any>, SignalState<any>>;
  effects: Computation<any>[];
  promises: Set<Promise<any>>;
  queue: Set<Computation<any>>;
  scheduler?: (fn: () => void) => unknown;
  running: boolean;
  done?: Promise<void>;
  resolve?: () => void;
}

type ExternalSourceFactory = <Prev, Next extends Prev = Prev>(
  fn: EffectFunction<Prev, Next>,
  trigger: () => void
) => ExternalSource;

export interface ExternalSource {
  track: EffectFunction<any, any>;
  dispose: () => void;
}

export type RootFunction<T> = (dispose: () => void) => T;

/**
 * Creates a new non-tracked reactive context that doesn't auto-dispose
 *
 * @param fn a function in which the reactive state is scoped
 * @param detachedOwner optional reactive context to bind the root to
 * @returns the output of `fn`.
 *
 * @description https://www.solidjs.com/docs/latest/api#createroot
 */
export function createRoot<T>(fn: RootFunction<T>, detachedOwner?: Owner): T {
  const listener = Listener,
    owner = Owner,
    unowned = fn.length === 0,
    root: Owner =
      unowned && !"_SOLID_DEV_"
        ? UNOWNED
        : { owned: null, cleanups: null, context: null, owner: detachedOwner || owner },
    updateFn = unowned
      ? "_SOLID_DEV_"
        ? () =>
            fn(() => {
              throw new Error("Dispose method must be an explicit argument to createRoot function");
            })
        : fn
      : () => fn(() => untrack(() => destroyNode(root)));

  if ("_SOLID_DEV_") {
    if (owner) root.name = `${owner.name}-r${rootCount++}`;
    globalThis._$afterCreateRoot && globalThis._$afterCreateRoot(root);
  }

  Owner = root;
  Listener = null;

  try {
    return runUpdates(updateFn as () => T)!;
  } finally {
    Listener = listener;
    Owner = owner;
  }
}

export type Accessor<T> = () => T;

export type Setter<T> = (undefined extends T ? () => undefined : {}) &
  (<U extends T>(value: (prev: T) => U) => U) &
  (<U extends T>(value: Exclude<U, Function>) => U) &
  (<U extends T>(value: Exclude<U, Function> | ((prev: T) => U)) => U);

export type Signal<T> = [get: Accessor<T>, set: Setter<T>];

export interface SignalOptions<T> extends MemoOptions<T> {
  internal?: boolean;
}

/**
 * Creates a simple reactive state with a getter and setter
 * ```typescript
 * const [state: Accessor<T>, setState: Setter<T>] = createSignal<T>(
 *  value: T,
 *  options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * )
 * ```
 * @param value initial value of the state; if empty, the state's type will automatically extended with undefined; otherwise you need to extend the type manually if you want setting to undefined not be an error
 * @param options optional object with a name for debugging purposes and equals, a comparator function for the previous and next value to allow fine-grained control over the reactivity
 *
 * @returns ```typescript
 * [state: Accessor<T>, setState: Setter<T>]
 * ```
 * * the Accessor is merely a function that returns the current value and registers each call to the reactive root
 * * the Setter is a function that allows directly setting or mutating the value:
 * ```typescript
 * const [count, setCount] = createSignal(0);
 * setCount(count => count + 1);
 * ```
 *
 * @description https://www.solidjs.com/docs/latest/api#createsignal
 */
export function createSignal<T>(): Signal<T | undefined>;
export function createSignal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
export function createSignal<T>(value?: T, options?: SignalOptions<T>): Signal<T | undefined> {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;

  const s: SignalState<T> = {
    value,
    observers: null,
    comparator: options.equals || undefined
  };

  if ("_SOLID_DEV_" && !options.internal)
    s.name = registerGraph(options.name || "s", s as { value: unknown });

  const setter: Setter<T | undefined> = (value?: unknown) => {
    if (typeof value === "function") {
      value = value(s.value);
    }
    return writeSignal(s, value);
  };

  return [readSignal.bind(s), setter];
}

export interface BaseOptions {
  name?: string;
}

// Magic type that when used at sites where generic types are inferred from, will prevent those sites from being involved in the inference.
// https://github.com/microsoft/TypeScript/issues/14829
// TypeScript Discord conversation: https://discord.com/channels/508357248330760243/508357248330760249/911266491024949328
export type NoInfer<T extends any> = [T][T extends any ? 0 : never];

export interface EffectOptions extends BaseOptions {}

// Also similar to OnEffectFunction
export type EffectFunction<Prev, Next extends Prev = Prev> = (v: Prev) => Next;

/**
 * Creates a reactive computation that runs during the render phase as DOM elements are created and updated but not necessarily connected
 * ```typescript
 * export function createRenderEffect<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://www.solidjs.com/docs/latest/api#createrendereffect
 */
export function createRenderEffect<Next>(fn: EffectFunction<undefined | NoInfer<Next>, Next>): void;
export function createRenderEffect<Next, Init = Next>(
  fn: EffectFunction<Init | Next, Next>,
  value: Init,
  options?: EffectOptions
): void;
export function createRenderEffect<Next, Init>(
  fn: EffectFunction<Init | Next, Next>,
  value?: Init,
  options?: EffectOptions
): void {
  const c = createComputation(fn, value!, true, STALE, "_SOLID_DEV_" ? options : undefined);
  updateComputation(c);
}

/**
 * Creates a reactive computation that runs after the render phase
 * ```typescript
 * export function createEffect<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://www.solidjs.com/docs/latest/api#createeffect
 */
export function createEffect<Next>(fn: EffectFunction<undefined | NoInfer<Next>, Next>): void;
export function createEffect<Next, Init = Next>(
  fn: EffectFunction<Init | Next, Next>,
  value: Init,
  options?: EffectOptions
): void;
export function createEffect<Next, Init>(
  fn: EffectFunction<Init | Next, Next>,
  value?: Init,
  options?: EffectOptions
): void {
  runEffects = runUserEffects;
  const c = createComputation(fn, value!, true, STALE, "_SOLID_DEV_" ? options : undefined),
    s = SuspenseContext && lookup(Owner, SuspenseContext.id);
  if (s) c.suspense = s;
  c.user = true;
  Effects ? Effects.push(c) : updateComputation(c);
}

/**
 * Creates a reactive computation that runs after the render phase with flexible tracking
 * ```typescript
 * export function createReaction(
 *   onInvalidate: () => void,
 *   options?: { name?: string }
 * ): (fn: () => void) => void;
 * ```
 * @param invalidated a function that is called when tracked function is invalidated.
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://www.solidjs.com/docs/latest/api#createreaction
 */
export function createReaction(onInvalidate: () => void, options?: EffectOptions) {
  let fn: (() => void) | undefined;
  const c = createComputation(
      () => {
        fn ? fn() : untrack(onInvalidate);
        fn = undefined;
      },
      undefined,
      true,
      0,
      "_SOLID_DEV_" ? options : undefined
    ),
    s = SuspenseContext && lookup(Owner, SuspenseContext.id);
  if (s) c.suspense = s;
  c.user = true;
  return (tracking: () => void) => {
    fn = tracking;
    updateComputation(c);
  };
}

export interface Memo<Prev, Next = Prev> extends SignalState<Next>, Computation<Next> {}

export interface MemoOptions<T> extends EffectOptions {
  equals?: false | ((prev: T, next: T) => boolean);
}

/**
 * Creates a readonly derived reactive memoized signal
 * ```typescript
 * export function createMemo<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * ): () => T;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes and use a custom comparison function in equals
 *
 * @description https://www.solidjs.com/docs/latest/api#creatememo
 */
// The extra Prev generic parameter separates inference of the effect input
// parameter type from inference of the effect return type, so that the effect
// return type is always used as the memo Accessor's return type.
export function createMemo<Next extends Prev, Prev = Next>(
  fn: EffectFunction<undefined | NoInfer<Prev>, Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init = Next, Prev = Next>(
  fn: EffectFunction<Init | Prev, Next>,
  value: Init,
  options?: MemoOptions<Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init, Prev>(
  fn: EffectFunction<Init | Prev, Next>,
  value?: Init,
  options?: MemoOptions<Next>
): Accessor<Next> {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;

  const c: Partial<Memo<Init, Next>> = createComputation(
    fn,
    value!,
    false,
    STALE,
    "_SOLID_DEV_" ? options : undefined
  ) as Partial<Memo<Init, Next>>;

  c.observers = null;
  c.comparator = options.equals || undefined;

  return readSignal.bind(c as Memo<Init, Next>);
}

interface Unresolved {
  state: "unresolved";
  loading: false;
  error: undefined;
  latest: undefined;
  (): undefined;
}

interface Pending {
  state: "pending";
  loading: true;
  error: undefined;
  latest: undefined;
  (): undefined;
}

interface Ready<T> {
  state: "ready";
  loading: false;
  error: undefined;
  latest: T;
  (): T;
}

interface Refreshing<T> {
  state: "refreshing";
  loading: true;
  error: undefined;
  latest: T;
  (): T;
}

interface Errored {
  state: "errored";
  loading: false;
  error: any;
  latest: never;
  (): never;
}

export type Resource<T> = Unresolved | Pending | Ready<T> | Refreshing<T> | Errored;

export type InitializedResource<T> = Ready<T> | Refreshing<T> | Errored;

export type ResourceActions<T, R = unknown> = {
  mutate: Setter<T>;
  refetch: (info?: R) => T | Promise<T> | undefined | null;
};

export type ResourceSource<S> = S | false | null | undefined | (() => S | false | null | undefined);

export type ResourceFetcher<S, T, R = unknown> = (
  k: S,
  info: ResourceFetcherInfo<T, R>
) => T | Promise<T>;

export type ResourceFetcherInfo<T, R = unknown> = {
  value: T | undefined;
  refetching: R | boolean;
};

export type ResourceOptions<T, S = unknown> = {
  initialValue?: T;
  name?: string;
  deferStream?: boolean;
  ssrLoadFrom?: "initial" | "server";
  storage?: (init: T | undefined) => [Accessor<T | undefined>, Setter<T | undefined>];
  onHydrated?: (k: S | undefined, info: { value: T | undefined }) => void;
};

export type InitializedResourceOptions<T, S = unknown> = ResourceOptions<T, S> & {
  initialValue: T;
};

export type ResourceReturn<T, R = unknown> = [Resource<T>, ResourceActions<T | undefined, R>];

export type InitializedResourceReturn<T, R = unknown> = [
  InitializedResource<T>,
  ResourceActions<T, R>
];

/**
 * Creates a resource that wraps a repeated promise in a reactive pattern:
 * ```typescript
 * // Without source
 * const [resource, { mutate, refetch }] = createResource(fetcher, options);
 * // With source
 * const [resource, { mutate, refetch }] = createResource(source, fetcher, options);
 * ```
 * @param source - reactive data function which has its non-nullish and non-false values passed to the fetcher, optional
 * @param fetcher - function that receives the source (true if source not provided), the last or initial value, and whether the resource is being refetched, and returns a value or a Promise:
 * ```typescript
 * const fetcher: ResourceFetcher<S, T, R> = (
 *   sourceOutput: S,
 *   info: { value: T | undefined, refetching: R | boolean }
 * ) => T | Promise<T>;
 * ```
 * @param options - an optional object with the initialValue and the name (for debugging purposes); see {@link ResourceOptions}
 *
 * @returns ```typescript
 * [Resource<T>, { mutate: Setter<T>, refetch: () => void }]
 * ```
 *
 * * Setting an `initialValue` in the options will mean that both the prev() accessor and the resource should never return undefined (if that is wanted, you need to extend the type with undefined)
 * * `mutate` allows to manually overwrite the resource without calling the fetcher
 * * `refetch` will re-run the fetcher without changing the source, and if called with a value, that value will be passed to the fetcher via the `refetching` property on the fetcher's second parameter
 *
 * @description https://www.solidjs.com/docs/latest/api#createresource
 */
export function createResource<T, R = unknown>(
  fetcher: ResourceFetcher<true, T, R>,
  options: InitializedResourceOptions<NoInfer<T>, true>
): InitializedResourceReturn<T, R>;
export function createResource<T, R = unknown>(
  fetcher: ResourceFetcher<true, T, R>,
  options?: ResourceOptions<NoInfer<T>, true>
): ResourceReturn<T, R>;
export function createResource<T, S, R = unknown>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T, R>,
  options: InitializedResourceOptions<NoInfer<T>, S>
): InitializedResourceReturn<T, R>;
export function createResource<T, S, R = unknown>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T, R>,
  options?: ResourceOptions<NoInfer<T>, S>
): ResourceReturn<T, R>;
export function createResource<T, S, R>(
  pSource: ResourceSource<S> | ResourceFetcher<S, T, R>,
  pFetcher?: ResourceFetcher<S, T, R> | ResourceOptions<T, S>,
  pOptions?: ResourceOptions<T, S> | undefined
): ResourceReturn<T, R> {
  let source: ResourceSource<S>;
  let fetcher: ResourceFetcher<S, T, R>;
  let options: ResourceOptions<T, S>;
  if ((arguments.length === 2 && typeof pFetcher === "object") || arguments.length === 1) {
    source = true as ResourceSource<S>;
    fetcher = pSource as ResourceFetcher<S, T, R>;
    options = (pFetcher || {}) as ResourceOptions<T, S>;
  } else {
    source = pSource as ResourceSource<S>;
    fetcher = pFetcher as ResourceFetcher<S, T, R>;
    options = pOptions || ({} as ResourceOptions<T, S>);
  }

  let pr: Promise<T> | null = null,
    initP: Promise<T> | T | typeof NO_INIT = NO_INIT,
    id: string | null = null,
    loadedUnderTransition: boolean | null = false,
    scheduled = false,
    resolved = "initialValue" in options,
    dynamic =
      typeof source === "function" && createMemo(source as () => S | false | null | undefined);

  const contexts = new Set<SuspenseContextType>(),
    [value, setValue] = (options.storage || createSignal)(options.initialValue) as Signal<
      T | undefined
    >,
    [error, setError] = createSignal<unknown>(undefined),
    [track, trigger] = createSignal(undefined, { equals: false }),
    [state, setState] = createSignal<"unresolved" | "pending" | "ready" | "refreshing" | "errored">(
      resolved ? "ready" : "unresolved"
    );

  if (sharedConfig.context) {
    id = `${sharedConfig.context.id}${sharedConfig.context.count++}`;
    let v;
    if (options.ssrLoadFrom === "initial") initP = options.initialValue as T;
    else if (sharedConfig.load && (v = sharedConfig.load(id))) initP = v[0];
  }
  function loadEnd(p: Promise<T> | null, v: T | undefined, error?: any, key?: S) {
    if (pr === p) {
      pr = null;
      resolved = true;
      if ((p === initP || v === initP) && options.onHydrated)
        queueMicrotask(() => options.onHydrated!(key, { value: v }));
      initP = NO_INIT;
      if (Transition && p && loadedUnderTransition) {
        Transition.promises.delete(p);
        loadedUnderTransition = false;
        runUpdates(() => {
          Transition!.running = true;
          completeLoad(v, error);
        });
      } else completeLoad(v, error);
    }
    return v;
  }
  function completeLoad(v: T | undefined, err: any) {
    runUpdates(() => {
      if (!err) setValue(() => v);
      setState(err ? "errored" : "ready");
      setError(err);
      for (const c of contexts.keys()) c.decrement!();
      contexts.clear();
    });
  }

  function read() {
    const c = SuspenseContext && lookup(Owner, SuspenseContext.id),
      v = value(),
      err = error();
    if (err && !pr) throw err;
    if (Listener && !Listener.user && c) {
      createComputed(() => {
        track();
        if (pr) {
          if (c.resolved && Transition && loadedUnderTransition) Transition.promises.add(pr);
          else if (!contexts.has(c)) {
            c.increment();
            contexts.add(c);
          }
        }
      });
    }
    return v;
  }
  function load(refetching: R | boolean = true) {
    if (refetching !== false && scheduled) return;
    scheduled = false;
    const lookup = dynamic ? dynamic() : (source as S);
    loadedUnderTransition = Transition && Transition.running;
    if (lookup == null || lookup === false) {
      loadEnd(pr, untrack(value));
      return;
    }
    if (Transition && pr) Transition.promises.delete(pr);
    const p =
      initP !== NO_INIT
        ? (initP as T | Promise<T>)
        : untrack(() =>
            fetcher(lookup, {
              value: value(),
              refetching
            })
          );
    if (typeof p !== "object" || !(p && "then" in p)) {
      loadEnd(pr, p, undefined, lookup);
      return p;
    }
    pr = p;
    scheduled = true;
    queueMicrotask(() => (scheduled = false));
    runUpdates(() => {
      setState(resolved ? "refreshing" : "pending");
      trigger();
    });
    return p.then(
      v => loadEnd(p, v, undefined, lookup),
      e => loadEnd(p, undefined, castError(e), lookup)
    ) as Promise<T>;
  }
  Object.defineProperties(read, {
    state: { get: () => state() },
    error: { get: () => error() },
    loading: {
      get() {
        const s = state();
        return s === "pending" || s === "refreshing";
      }
    },
    latest: {
      get() {
        if (!resolved) return read();
        const err = error();
        if (err && !pr) throw err;
        return value();
      }
    }
  });
  if (dynamic) createComputed(() => load(false));
  else load(false);
  return [read as Resource<T>, { refetch: load, mutate: setValue }];
}

export interface DeferredOptions<T> {
  equals?: false | ((prev: T, next: T) => boolean);
  name?: string;
  timeoutMs?: number;
}

/**
 * Creates a reactive computation that only runs and notifies the reactive context when the browser is idle
 * ```typescript
 * export function createDeferred<T>(
 *   fn: (v: T) => T,
 *   options?: { timeoutMs?: number, name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * ): () => T);
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param options allows to set the timeout in milliseconds, use a custom comparison function and set a name in dev mode for debugging purposes
 *
 * @description https://www.solidjs.com/docs/latest/api#createdeferred
 */
export function createDeferred<T>(source: Accessor<T>, options?: DeferredOptions<T>) {
  let t: Task,
    timeout = options ? options.timeoutMs : undefined;
  const node = createComputation(
    () => {
      if (!t || !t.fn)
        t = requestCallback(
          () => setDeferred(() => node.value as T),
          timeout !== undefined ? { timeout } : undefined
        );
      return source();
    },
    undefined,
    true
  );
  const [deferred, setDeferred] = createSignal(node.value as T, options);
  updateComputation(node);
  setDeferred(() => node.value as T);
  return deferred;
}

export type EqualityCheckerFunction<T, U> = (a: U, b: T) => boolean;

/**
 * Creates a conditional signal that only notifies subscribers when entering or exiting their key matching the value
 * ```typescript
 * export function createSelector<T, U>(
 *   source: () => T
 *   fn: (a: U, b: T) => boolean,
 *   options?: { name?: string }
 * ): (k: U) => boolean;
 * ```
 * @param source
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param options allows to set a name in dev mode for debugging purposes, optional
 *
 * ```typescript
 * const isSelected = createSelector(selectedId);
 * <For each={list()}>
 *   {(item) => <li classList={{ active: isSelected(item.id) }}>{item.name}</li>}
 * </For>
 * ```
 *
 * This makes the operation O(2) instead of O(n).
 *
 * @description https://www.solidjs.com/docs/latest/api#createselector
 */
export function createSelector<T, U>(
  source: Accessor<T>,
  fn: EqualityCheckerFunction<T, U> = equalFn as TODO,
  options?: BaseOptions
): (key: U) => boolean {
  const subs = new Map<U, Set<Computation<any>>>();
  const node = createComputation(
    (p: T | undefined) => {
      const v = source();
      for (const [key, val] of subs.entries())
        if (fn(key, v) !== fn(key, p!)) {
          for (const c of val.values()) {
            c.state = STALE;
            if (c.effect) Effects!.push(c);
          }
        }
      return v;
    },
    undefined,
    true,
    STALE,
    "_SOLID_DEV_" ? options : undefined
  ) as Memo<any>;
  updateComputation(node);
  return (key: U) => {
    const listener = Listener;
    if (listener) {
      let l: Set<Computation<any>> | undefined;
      if ((l = subs.get(key))) l.add(listener);
      else subs.set(key, (l = new Set([listener])));
      onCleanup(() => {
        l!.delete(listener!);
        !l!.size && subs.delete(key);
      });
    }
    return fn(key, node.value!);
  };
}

/**
 * Holds changes inside the block before the reactive context is updated
 * @param fn wraps the reactive updates that should be batched
 * @returns the return value from `fn`
 *
 * @description https://www.solidjs.com/docs/latest/api#batch
 */
export function batch<T>(fn: Accessor<T>): T {
  return runUpdates(fn) as T;
}

/**
 * Ignores tracking context inside its scope
 * @param fn the scope that is out of the tracking context
 * @returns the return value of `fn`
 *
 * @description https://www.solidjs.com/docs/latest/api#untrack
 */
export function untrack<T>(fn: Accessor<T>): T {
  const listener = Listener;
  Listener = null;
  try {
    return fn();
  } finally {
    Listener = listener;
  }
}

/** @deprecated */
export type ReturnTypes<T> = T extends readonly Accessor<unknown>[]
  ? { [K in keyof T]: T[K] extends Accessor<infer I> ? I : never }
  : T extends Accessor<infer I>
  ? I
  : never;

// transforms a tuple to a tuple of accessors in a way that allows generics to be inferred
export type AccessorArray<T> = [...Extract<{ [K in keyof T]: Accessor<T[K]> }, readonly unknown[]>];

// Also similar to EffectFunction
export type OnEffectFunction<S, Prev, Next extends Prev = Prev> = (
  input: S,
  prevInput: S | undefined,
  prev: Prev
) => Next;

export interface OnOptions {
  defer?: boolean;
}

/**
 * on - make dependencies of a computation explicit
 * ```typescript
 * export function on<S, U>(
 *   deps: Accessor<S> | AccessorArray<S>,
 *   fn: (input: S, prevInput: S | undefined, prevValue: U | undefined) => U,
 *   options?: { defer?: boolean } = {}
 * ): (prevValue: U | undefined) => U;
 * ```
 * @param deps list of reactive dependencies or a single reactive dependency
 * @param fn computation on input; the current previous content(s) of input and the previous value are given as arguments and it returns a new value
 * @param options optional, allows deferred computation until at the end of the next change
 * @returns an effect function that is passed into createEffect. For example:
 *
 * ```typescript
 * createEffect(on(a, (v) => console.log(v, b())));
 *
 * // is equivalent to:
 * createEffect(() => {
 *   const v = a();
 *   untrack(() => console.log(v, b()));
 * });
 * ```
 *
 * @description https://www.solidjs.com/docs/latest/api#on
 */
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options?: OnOptions & { defer?: false }
): EffectFunction<undefined | NoInfer<Next>, NoInfer<Next>>;
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options: OnOptions & { defer: true }
): EffectFunction<undefined | NoInfer<Next>>;
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options?: OnOptions
): EffectFunction<undefined | NoInfer<Next>> {
  const isArray = Array.isArray(deps);
  let prevInput: S;
  let defer = options && options.defer;
  return prevValue => {
    let input: S;
    if (isArray) {
      input = Array(deps.length) as unknown as S;
      for (let i = 0; i < deps.length; i++) (input as unknown as TODO[])[i] = deps[i]();
    } else input = deps();
    if (defer) {
      defer = false;
      return undefined;
    }
    const result = untrack(() => fn(input, prevInput, prevValue));
    prevInput = input;
    return result;
  };
}

/**
 * onMount - run an effect only after initial render on mount
 * @param fn an effect that should run only once on mount
 *
 * @description https://www.solidjs.com/docs/latest/api#onmount
 */
export function onMount(fn: () => void) {
  createEffect(() => untrack(fn));
}

/**
 * onCleanup - run an effect once before the reactive scope is disposed
 * @param fn an effect that should run only once on cleanup
 *
 * @description https://www.solidjs.com/docs/latest/api#oncleanup
 */
export function onCleanup(fn: () => void) {
  if (Owner === null)
    "_SOLID_DEV_" &&
      console.warn("cleanups created outside a `createRoot` or `render` will never be run");
  else if (Owner.cleanups === null) Owner.cleanups = [fn];
  else Owner.cleanups.push(fn);
  return fn;
}

/**
 * onError - run an effect whenever an error is thrown within the context of the child scopes
 * @param fn an error handler that receives the error
 *
 * * If the error is thrown again inside the error handler, it will trigger the next available parent handler
 *
 * @description https://www.solidjs.com/docs/latest/api#onerror
 */
export function onError(fn: (err: any) => void): void {
  ERROR || (ERROR = Symbol("error"));
  if (Owner === null)
    "_SOLID_DEV_" &&
      console.warn("error handlers created outside a `createRoot` or `render` will never be run");
  else if (Owner.context === null) Owner.context = { [ERROR]: [fn] };
  else if (!Owner.context[ERROR]) Owner.context[ERROR] = [fn];
  else Owner.context[ERROR].push(fn);
}

export function getListener() {
  return Listener;
}

export function getOwner() {
  return Owner;
}

export function runWithOwner<T>(o: Owner, fn: () => T): T {
  const prev = Owner;
  Owner = o;
  try {
    return runUpdates(fn)!;
  } finally {
    Owner = prev;
  }
}

// Transitions
export function enableScheduling(scheduler = requestCallback) {
  Scheduler = scheduler;
}

/**
 * ```typescript
 * export function startTransition(fn: () => void) => Promise<void>
 *
 * @description https://www.solidjs.com/docs/latest/api#usetransition
 */
export function startTransition(fn: () => unknown): Promise<void> {
  if (Transition && Transition.running) {
    fn();
    return Transition.done!;
  }
  const l = Listener;
  const o = Owner;
  return Promise.resolve().then(() => {
    Listener = l;
    Owner = o;
    let t: TransitionState | undefined;
    if (Scheduler || SuspenseContext) {
      t =
        Transition ||
        (Transition = {
          sources: new Map(),
          effects: [],
          promises: new Set(),
          queue: new Set(),
          running: true
        });
      t.done || (t.done = new Promise(res => (t!.resolve = res)));
      t.running = true;
    }
    runUpdates(fn);
    Listener = Owner = null;
    return t ? t.done : undefined;
  });
}

export type Transition = [Accessor<boolean>, (fn: () => void) => Promise<void>];

/**
 * ```typescript
 * export function useTransition(): [
 *   () => boolean,
 *   (fn: () => void, cb?: () => void) => void
 * ];
 * @returns a tuple; first value is an accessor if the transition is pending and a callback to start the transition
 *
 * @description https://www.solidjs.com/docs/latest/api#usetransition
 */
export function useTransition(): Transition {
  return [transPending, startTransition];
}

export function resumeEffects(e: Computation<any>[]) {
  Effects!.push.apply(Effects, e);
  e.length = 0;
}

export interface DevComponent<T> extends Memo<JSX.Element> {
  props: T;
  componentName: string;
}

// Dev
export function devComponent<T>(Comp: (props: T) => JSX.Element, props: T) {
  const c = createComputation(
    () =>
      untrack(() => {
        Object.assign(Comp, { [$DEVCOMP]: true });
        return Comp(props);
      }),
    undefined,
    false
  ) as DevComponent<T>;
  c.props = props;
  c.observers = null;
  c.state = CLEAN;
  c.componentName = Comp.name;
  updateComputation(c);
  return c.value;
}

export function registerGraph(name: string, value: { value: unknown }): string {
  let tryName = name;
  if (Owner) {
    let i = 0;
    Owner.sourceMap || (Owner.sourceMap = {});
    while (Owner.sourceMap[tryName]) tryName = `${name}-${++i}`;
    Owner.sourceMap[tryName] = value;
  }
  return tryName;
}

export type ContextProviderComponent<T> = FlowComponent<{ value: T }>;

// Context API
export interface Context<T> {
  id: symbol;
  Provider: ContextProviderComponent<T>;
  defaultValue: T;
}

/**
 * Creates a Context to handle a state scoped for the children of a component
 * ```typescript
 * interface Context<T> {
 *   id: symbol;
 *   Provider: FlowComponent<{ value: T }>;
 *   defaultValue: T;
 * }
 * export function createContext<T>(
 *   defaultValue?: T,
 *   options?: { name?: string }
 * ): Context<T | undefined>;
 * ```
 * @param defaultValue optional default to inject into context
 * @param options allows to set a name in dev mode for debugging purposes
 * @returns The context that contains the Provider Component and that can be used with `useContext`
 *
 * @description https://www.solidjs.com/docs/latest/api#createcontext
 */
export function createContext<T>(
  defaultValue?: undefined,
  options?: EffectOptions
): Context<T | undefined>;
export function createContext<T>(defaultValue: T, options?: EffectOptions): Context<T>;
export function createContext<T>(
  defaultValue?: T,
  options?: EffectOptions
): Context<T | undefined> {
  const id = Symbol("context");
  return { id, Provider: createProvider(id, options), defaultValue };
}

/**
 * use a context to receive a scoped state from a parent's Context.Provider
 *
 * @param context Context object made by `createContext`
 * @returns the current or `defaultValue`, if present
 *
 * @description https://www.solidjs.com/docs/latest/api#usecontext
 */
export function useContext<T>(context: Context<T>): T {
  let ctx;
  return (ctx = lookup(Owner, context.id)) !== undefined ? ctx : context.defaultValue;
}

export type ResolvedJSXElement = Exclude<JSX.Element, JSX.ArrayElement | JSX.FunctionElement>;
export type ResolvedChildren = ResolvedJSXElement | ResolvedJSXElement[];
export type ChildrenReturn = Accessor<ResolvedChildren> & { toArray: () => ResolvedJSXElement[] };

/**
 * Resolves child elements to help interact with children
 *
 * @param fn an accessor for the children
 * @returns a accessor of the same children, but resolved
 *
 * @description https://www.solidjs.com/docs/latest/api#children
 */
export function children(fn: Accessor<JSX.Element>): ChildrenReturn {
  const children = createMemo(fn);
  const memo = "_SOLID_DEV_"
    ? createMemo(() => resolveChildren(children()), undefined, { name: "children" })
    : createMemo(() => resolveChildren(children()));
  (memo as ChildrenReturn).toArray = () => {
    const c = memo();
    return Array.isArray(c) ? c : c != null ? [c] : [];
  };
  return memo as ChildrenReturn;
}

// Resource API
export type SuspenseContextType = {
  increment?: () => void;
  decrement?: () => void;
  inFallback?: () => boolean;
  effects?: Computation<any>[];
  resolved?: boolean;
};

type SuspenseContext = Context<SuspenseContextType> & {
  active?(): boolean;
  increment?(): void;
  decrement?(): void;
};

let SuspenseContext: SuspenseContext;

export function getSuspenseContext() {
  return SuspenseContext || (SuspenseContext = createContext<SuspenseContextType>({}));
}

// Interop
export function enableExternalSource(factory: ExternalSourceFactory) {
  if (ExternalSourceFactory) {
    const oldFactory = ExternalSourceFactory;
    ExternalSourceFactory = (fn, trigger) => {
      const oldSource = oldFactory(fn, trigger);
      const source = factory(x => oldSource.track(x), trigger);
      return {
        track: x => source.track(x),
        dispose() {
          source.dispose();
          oldSource.dispose();
        }
      };
    };
  } else {
    ExternalSourceFactory = factory;
  }
}

// Internal
export function readSignal(this: SignalState<any> | Memo<any>) {
  if (Listener) {
    if (!CurrentGets && Listener.sources && Listener.sources[CurrentGetsIndex] == this) {
      CurrentGetsIndex++;
    } else {
      if (!CurrentGets) CurrentGets = [this];
      else CurrentGets.push(this);
    }
  }
  if ("state" in this && this.state !== CLEAN) {
    runUpdates(() => updateIfNecessary(this as Memo<any>));
  }
  return this.value;
}

export function writeSignal(node: SignalState<any> | Memo<any>, value: any, isComp?: boolean) {
  const tNode = Transition && Transition.running && Transition.sources.get(node);
  let current = tNode ? tNode.value : node.value;
  if (!node.comparator || !node.comparator(current, value)) {
    if (Transition) {
      const TransitionRunning = Transition.running;
      if (TransitionRunning || (!isComp && Transition.sources.has(node))) {
        Transition.sources.set(node, null as any);
      } else node.value = value;
    } else node.value = value;
    if (node.observers && node.observers.length) {
      runUpdates(() => {
        for (let i = 0; i < node.observers!.length; i++) {
          const o = node.observers![i];
          if (o.state === CLEAN) {
            if (o.effect) Effects!.push(o);
            if ((o as Memo<any>).observers) markDownstream(o as Memo<any>);
          }
          o.state = STALE;
        }
      });
    }
  }
  return value;
}

function updateComputation(node: Computation<any>) {
  if (!node.fn) return;
  destroyNode(node);
  
  (node as Computation<any>).state = CLEAN;
  node.context = null;
  "_SOLID_DEV_" && delete node.sourceMap;

  const owner = Owner,
    listener = Listener,
    currentGets = CurrentGets,
    currentGetsIndex = CurrentGetsIndex;
  Listener = Owner = node;
  CurrentGetsIndex = 0;
  CurrentGets = null;
  runComputation(node, node.value);

  updateObservers(node);

  if (Transition && !Transition.running && Transition.sources.has(node as Memo<any>)) {
    queueMicrotask(() => {
      runUpdates(() => {
        Transition && (Transition.running = true);
        Listener = Owner = node;
        runComputation(node, (node as Memo<any>).value);
        Listener = Owner = null;
      });
    });
  }
  Listener = listener;
  Owner = owner;
  CurrentGets = currentGets;
  CurrentGetsIndex = currentGetsIndex;
}

function runComputation(node: Computation<any>, value: any) {
  let nextValue;
  try {
    nextValue = node.fn(value);
  } catch (err) {
    if (!node.effect) node.state = STALE;
    handleError(err);
  }
  if ("observers" in (node as Memo<any>)) {
    writeSignal(node as Memo<any>, nextValue, true);
  } else node.value = nextValue;
}

function createComputation<Next, Init = unknown>(
  fn: EffectFunction<Init | Next, Next>,
  init: Init,
  effect: boolean,
  state: number = STALE,
  options?: EffectOptions
): Computation<Init | Next, Next> {
  const c: Computation<Init | Next, Next> = {
    fn,
    state: state,
    owned: null,
    sources: null,
    cleanups: null,
    value: init,
    owner: Owner,
    context: null,
    effect: effect
  };

  if (Owner === null)
    "_SOLID_DEV_" &&
      console.warn(
        "computations created outside a `createRoot` or `render` will never be disposed"
      );
  else if (Owner !== UNOWNED) {
    if (!Owner.owned) Owner.owned = [c];
    else Owner.owned.push(c);

    if ("_SOLID_DEV_")
      c.name =
        (options && options.name) ||
        `${(Owner as Computation<any>).name || "c"}-${Owner.owned.length}`;
  }

  if (ExternalSourceFactory) {
    const [track, trigger] = createSignal<void>(undefined, { equals: false });
    const ordinary = ExternalSourceFactory(c.fn, trigger);
    onCleanup(() => ordinary.dispose());
    const triggerInTransition: () => void = () =>
      startTransition(trigger).then(() => inTransition.dispose());
    const inTransition = ExternalSourceFactory(c.fn, triggerInTransition);
    c.fn = x => {
      track();
      return Transition && Transition.running ? inTransition.track(x) : ordinary.track(x);
    };
  }

  return c;
}

function runTop(node: Computation<any>) {
  if (node.state === CLEAN) return;
  if (node.suspense && untrack(node.suspense.inFallback!))
    return node!.suspense.effects!.push(node!);

  const ancestors = [node];
  while ((node = node.owner as Computation<any>)) {
    if (node.state !== CLEAN) ancestors.push(node);
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    node = ancestors[i];
    runUpdates(() => updateIfNecessary(node));
  }
}

function runUpdates<T>(fn: () => T) {
  let topBatch = !Effects;
  if (topBatch) Effects = [];
  try {
    const res = fn();
    if (topBatch) completeUpdates();
    return res;
  } catch (err) {
    handleError(err);
  }
}

function completeUpdates() {
  const e = Effects!;
  Effects = null;
  if (e!.length) {
    if (Transition && Transition.running) scheduleQueue(e);
    else runQueue(e);
  }
  let res;
  if (Transition) {
    if (!Transition.promises.size && !Transition.queue.size) {
      // finish transition
      const sources = Transition.sources;
      Effects!.push.apply(Effects, Transition!.effects);
      res = Transition.resolve;
      Transition = null;

      runUpdates(() => {
        for (const [d, v] of sources) {
          if ((d as Memo<any>).sources) {
            destroySources(d as Memo<any>);
            destroyNode(d as Memo<any>);
          }
        }
        setTransPending(false);
      });
    } else if (Transition.running) {
      Transition.running = false;
      Transition.effects.push.apply(Transition.effects, Effects!);
      Effects = null;
      setTransPending(true);
      return;
    }
  } else if ("_SOLID_DEV_") globalThis._$afterUpdate && globalThis._$afterUpdate();
  if (res) res();
}

function runQueue(queue: Computation<any>[]) {
  for (let i = 0; i < queue.length; i++) runTop(queue[i]);
}

function scheduleQueue(queue: Computation<any>[]) {
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const tasks = Transition!.queue;
    if (!tasks.has(item)) {
      tasks.add(item);
      Scheduler!(() => {
        tasks.delete(item);
        runUpdates(() => {
          Transition!.running = true;
          runTop(item);
        });
        Transition && (Transition.running = false);
      });
    }
  }
}

function runUserEffects(queue: Computation<any>[]) {
  let i,
    userLength = 0;
  for (i = 0; i < queue.length; i++) {
    const e = queue[i];
    if (!e.user) runTop(e);
    else queue[userLength++] = e;
  }
  if (sharedConfig.context) setHydrateContext();
  for (i = 0; i < userLength; i++) runTop(queue[i]);
}

function updateIfNecessary(node: Computation<any>) {
  if (node.state === PENDING) {
    for (let i = 0; i < node.sources!.length; i++) {
      const source = node.sources![i] as Memo<any>;
      updateIfNecessary(source);
      if (source.state === STALE) break;
    }
  }
  if (node.state === STALE) updateComputation(node);
  node.state = CLEAN;
}

function markDownstream(node: Memo<any>) {
  for (let i = 0; i < node.observers!.length; i++) {
    const o = node.observers![i];
    if (o.state === CLEAN) {
      o.state = PENDING;
      if (o.effect) Effects!.push(o);
      (o as Memo<any>).observers && markDownstream(o as Memo<any>);
    }
  }
}

function destroySources(node: Computation<any>) {
  if (node.sources) {
    for (let i = 0; i < node.sources.length; i++) {
      const source: SignalState<any> = node.sources[i];
      const swap = source.observers!.findIndex(v => v === node);
      source.observers![swap] = source.observers![source.observers!.length - 1];
      source.observers!.pop();
    }
  }
}

function destroyNode(node: Owner) {
  if (node.owned) {
    for (let i = 0; i < node.owned.length; i++) destroyNode(node.owned[i]);
    node.owned = null;
  }

  if (node.cleanups) {
    for (let i = 0; i < node.cleanups.length; i++) node.cleanups[i]();
    node.cleanups = null;
  }
}

function updateObservers(node: Computation<any>) {
  if (CurrentGets) {
    let n = node as Computation<any>;
    if (n.sources) {
      for (let i = CurrentGetsIndex; i < n.sources!.length; i++) {
        const source: SignalState<any> = n.sources![i]; // We don't actually delete sources here because we're replacing the entire array soon
        const swap = source.observers!.findIndex(v => v === node);
        source.observers![swap] = source.observers![source.observers!.length - 1];
        source.observers!.pop();
      }
    }

    if (n.sources && CurrentGetsIndex > 0) {
      n.sources.length = CurrentGetsIndex + CurrentGets.length;
      for (let i = 0; i < CurrentGets.length; i++) {
        n.sources[CurrentGetsIndex + i] = CurrentGets[i];
      }
    } else {
      n.sources = CurrentGets;
    }

    for (let i = CurrentGetsIndex; i < n.sources.length; i++) {
      // Add ourselves to the end of the parent .observers array
      const source = n.sources[i];
      if (!source.observers) {
        source.observers = [n];
      } else {
        source.observers.push(n);
      }
    }
  }
}

function castError(err: any) {
  if (err instanceof Error || typeof err === "string") return err;
  return new Error("Unknown error");
}

function handleError(err: any) {
  err = castError(err);
  const fns = ERROR && lookup(Owner, ERROR);
  if (!fns) throw err;
  for (const f of fns) f(err);
}

function lookup(owner: Owner | null, key: symbol | string): any {
  return owner
    ? owner.context && owner.context[key] !== undefined
      ? owner.context[key]
      : lookup(owner.owner, key)
    : undefined;
}

function resolveChildren(children: JSX.Element): ResolvedChildren {
  if (typeof children === "function" && !children.length) return resolveChildren(children());
  if (Array.isArray(children)) {
    const results: any[] = [];
    for (let i = 0; i < children.length; i++) {
      const result = resolveChildren(children[i]);
      Array.isArray(result) ? results.push.apply(results, result) : results.push(result);
    }
    return results;
  }
  return children as ResolvedChildren;
}

function createProvider(id: symbol, options?: EffectOptions) {
  return function provider(props: FlowProps<{ value: unknown }>) {
    let res;
    createRenderEffect(
      () =>
        (res = untrack(() => {
          Owner!.context = { [id]: props.value };
          return children(() => props.children);
        })),
      undefined,
      options
    );
    return res;
  };
}

type TODO = any;
