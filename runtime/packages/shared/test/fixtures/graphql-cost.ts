import {
  Kind,
  parse,
  type ArgumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

const pageSizeOf = (
  field: { name: { value: string }; arguments?: readonly ArgumentNode[] },
  variables: Record<string, number>,
): number | null => {
  const argument = field.arguments?.find(({ name }) => name.value === 'first' || name.value === 'last');
  if (argument === undefined) return null;
  const { value } = argument;
  if (value.kind === Kind.INT) return Number(value.value);
  if (value.kind === Kind.VARIABLE) {
    const sent = variables[value.name.value];
    if (sent === undefined) {
      throw new Error(`no value sent for page size variable $${value.name.value} of ${field.name.value}`);
    }
    return sent;
  }
  throw new Error(`page size of ${field.name.value} is not an integer or a variable`);
};

export const countNodes = (query: string, variables: Record<string, number> = {}): number => {
  const document = parse(query);
  const fragments = new Map<string, FragmentDefinitionNode>(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment]),
  );
  const count = (selections: SelectionSetNode, parents: number): number =>
    selections.selections.reduce((total, selection) => {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments.get(selection.name.value);
        if (fragment === undefined) throw new Error(`fragment ${selection.name.value} is not defined`);
        return total + count(fragment.selectionSet, parents);
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) return total + count(selection.selectionSet, parents);
      if (selection.selectionSet === undefined) return total;
      const size = pageSizeOf(selection, variables);
      const nodes = size === null ? parents : parents * size;
      return total + (size === null ? 0 : nodes) + count(selection.selectionSet, nodes);
    }, 0);
  return document.definitions.reduce(
    (total, definition) =>
      definition.kind === Kind.OPERATION_DEFINITION ? total + count(definition.selectionSet, 1) : total,
    0,
  );
};
