import type { FigmaNode } from '@usepolder/current-core';

/**
 * A well-built component: auto layout, bound tokens, named layers, variants,
 * and interaction states declared both ways Figma allows — a `State` variant
 * whose `variantOptions` enumerate them, and a `Disabled` boolean property
 * whose key names its own state.
 *
 * Property keys carry the `#1:2` suffix a real file puts on them. It is
 * observed everywhere and documented nowhere, so every reader strips it when
 * present; the fixture keeps it so that stays exercised.
 */
export const buttonNode: FigmaNode = {
  id: '1:10',
  name: 'Button',
  type: 'COMPONENT_SET',
  componentPropertyDefinitions: {
    'Size#1:2': { type: 'VARIANT', defaultValue: 'large', variantOptions: ['large', 'small'] },
    'State#2:3': {
      type: 'VARIANT',
      defaultValue: 'Default',
      variantOptions: ['Default', 'Hover', 'Pressed'],
    },
    'Disabled#3:4': { type: 'BOOLEAN', defaultValue: false },
  },
  children: [
    {
      id: '1:11',
      name: 'Size=large, State=Default',
      type: 'COMPONENT',
      layoutMode: 'HORIZONTAL',
      itemSpacing: 8,
      cornerRadius: 4,
      fills: [{ type: 'SOLID' }],
      boundVariables: {
        fills: [{ id: 'V:colour' }],
        itemSpacing: { id: 'V:space' },
        cornerRadius: { id: 'V:radius' },
      },
      children: [
        {
          id: '1:12',
          name: 'Label',
          type: 'TEXT',
          styles: { text: 'S:body' },
          fills: [{ type: 'SOLID' }],
          boundVariables: { fills: [{ id: 'V:ink' }] },
        },
      ],
    },
  ],
};

/**
 * A neglected component: no auto layout, raw values, default layer names, and
 * no component properties at all — so DE6 answers N/A rather than No. The API
 * cannot tell a wrapper that needs no interaction states from one that forgot
 * them, which is the whole reason DE6 was a manual norm.
 */
export const wrapperNode: FigmaNode = {
  id: '1:20',
  name: 'Wrapper',
  type: 'COMPONENT',
  layoutMode: 'NONE',
  cornerRadius: 12,
  fills: [{ type: 'SOLID' }],
  children: [
    { id: '1:21', name: 'Rectangle 4', type: 'RECTANGLE', fills: [{ type: 'SOLID' }] },
    { id: '1:22', name: 'Frame 427', type: 'FRAME' },
  ],
};

export const fixtureNodes: Record<string, FigmaNode> = {
  '1:10': buttonNode,
  '1:20': wrapperNode,
  // "1:30" is deliberately absent: Ghost is mapped but not in the file.
};
