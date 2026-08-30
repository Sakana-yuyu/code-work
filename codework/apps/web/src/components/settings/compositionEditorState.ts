import { useEffect, useMemo, useRef, useState } from "react";

export type CompositionEditorState =
  | {
      readonly environmentId: string | null;
      readonly mode: "loading" | "creating";
      readonly selectedItemId: null;
    }
  | {
      readonly environmentId: string | null;
      readonly mode: "selected";
      readonly selectedItemId: string;
    }
  | {
      readonly environmentId: string | null;
      readonly mode: "deleting";
      readonly selectedItemId: null;
      readonly deletedItemId: string;
    };

export interface CompositionEditorStateInput {
  readonly environmentId: string | null;
  readonly isPending: boolean;
  readonly itemIds: ReadonlyArray<string>;
}

const selectFirstCompositionEditorItem = (
  environmentId: string | null,
  itemIds: ReadonlyArray<string>,
): CompositionEditorState => {
  const selectedItemId = itemIds[0];
  return selectedItemId === undefined
    ? { environmentId, mode: "creating", selectedItemId: null }
    : { environmentId, mode: "selected", selectedItemId };
};

export function createCompositionEditorState(
  input: CompositionEditorStateInput,
): CompositionEditorState {
  if (input.environmentId === null || input.isPending) {
    return { environmentId: input.environmentId, mode: "loading", selectedItemId: null };
  }
  return selectFirstCompositionEditorItem(input.environmentId, input.itemIds);
}

export function syncCompositionEditorState(
  state: CompositionEditorState,
  input: CompositionEditorStateInput,
): CompositionEditorState {
  if (state.environmentId !== input.environmentId) {
    return createCompositionEditorState(input);
  }
  if (input.environmentId === null) {
    return createCompositionEditorState(input);
  }
  if (input.isPending) {
    return state;
  }
  if (state.mode === "loading") {
    return selectFirstCompositionEditorItem(input.environmentId, input.itemIds);
  }
  if (state.mode === "creating") {
    return state;
  }
  if (state.mode === "deleting") {
    return selectFirstCompositionEditorItem(
      input.environmentId,
      input.itemIds.filter((itemId) => itemId !== state.deletedItemId),
    );
  }
  if (state.mode === "selected" && input.itemIds.includes(state.selectedItemId)) {
    return state;
  }
  return selectFirstCompositionEditorItem(input.environmentId, input.itemIds);
}

export function selectCompositionEditorItem(
  state: CompositionEditorState,
  selectedItemId: string,
): CompositionEditorState {
  return { environmentId: state.environmentId, mode: "selected", selectedItemId };
}

export function startCompositionEditorCreate(
  state: CompositionEditorState,
): CompositionEditorState {
  return { environmentId: state.environmentId, mode: "creating", selectedItemId: null };
}

export function markCompositionEditorItemDeleted(
  state: CompositionEditorState,
  deletedItemId: string,
): CompositionEditorState {
  return {
    environmentId: state.environmentId,
    mode: "deleting",
    selectedItemId: null,
    deletedItemId,
  };
}

interface UseCompositionEditorStateOptions<TItem, TDraft> {
  readonly environmentId: string | null;
  readonly isPending: boolean;
  readonly items: ReadonlyArray<TItem>;
  readonly getItemId: (item: TItem) => string;
  readonly createDraft: () => TDraft;
  readonly draftFromItem: (item: TItem) => TDraft;
}

const getDraftToken = (state: CompositionEditorState): string | null => {
  if (state.mode === "selected") {
    return `selected:${state.environmentId ?? "none"}:${state.selectedItemId}`;
  }
  if (state.mode === "creating") {
    return `creating:${state.environmentId ?? "none"}`;
  }
  return null;
};

export function useCompositionEditorState<TItem, TDraft>(
  options: UseCompositionEditorStateOptions<TItem, TDraft>,
) {
  const itemIds = useMemo(
    () => options.items.map(options.getItemId),
    [options.getItemId, options.items],
  );
  const input = useMemo<CompositionEditorStateInput>(
    () => ({
      environmentId: options.environmentId,
      isPending: options.isPending,
      itemIds,
    }),
    [itemIds, options.environmentId, options.isPending],
  );
  const [state, setState] = useState(() => createCompositionEditorState(input));
  const [draft, setDraft] = useState(() => {
    const initialState = createCompositionEditorState(input);
    if (initialState.mode === "selected") {
      const item = options.items.find(
        (candidate) => options.getItemId(candidate) === initialState.selectedItemId,
      );
      if (item !== undefined) {
        return options.draftFromItem(item);
      }
    }
    return options.createDraft();
  });
  const appliedDraftToken = useRef(getDraftToken(createCompositionEditorState(input)));

  useEffect(() => {
    setState((current) => syncCompositionEditorState(current, input));
  }, [input]);

  const draftToken = getDraftToken(state);
  useEffect(() => {
    if (draftToken === null || appliedDraftToken.current === draftToken) {
      return;
    }
    appliedDraftToken.current = draftToken;
    if (state.mode === "selected") {
      const item = options.items.find(
        (candidate) => options.getItemId(candidate) === state.selectedItemId,
      );
      if (item !== undefined) {
        setDraft(options.draftFromItem(item));
      }
      return;
    }
    if (state.mode === "creating") {
      setDraft(options.createDraft());
    }
  }, [
    draftToken,
    options.createDraft,
    options.draftFromItem,
    options.getItemId,
    options.items,
    state,
  ]);

  const selectedItem =
    state.mode === "selected"
      ? (options.items.find((item) => options.getItemId(item) === state.selectedItemId) ?? null)
      : null;

  return {
    draft,
    isCreating: state.mode === "creating",
    isLoading:
      state.mode === "loading" ||
      state.mode === "deleting" ||
      (state.mode === "selected" && selectedItem === null) ||
      draftToken !== appliedDraftToken.current,
    selectedItem,
    selectedItemId: state.mode === "selected" ? state.selectedItemId : null,
    setDraft,
    selectItem: (item: TItem): void => {
      setState((current) => selectCompositionEditorItem(current, options.getItemId(item)));
      appliedDraftToken.current = getDraftToken({
        environmentId: state.environmentId,
        mode: "selected",
        selectedItemId: options.getItemId(item),
      });
      setDraft(options.draftFromItem(item));
    },
    startCreate: (): void => {
      setState((current) => startCompositionEditorCreate(current));
      appliedDraftToken.current = getDraftToken({
        environmentId: state.environmentId,
        mode: "creating",
        selectedItemId: null,
      });
      setDraft(options.createDraft());
    },
    markItemDeleted: (itemId: string): void => {
      setState((current) => markCompositionEditorItemDeleted(current, itemId));
    },
  };
}
