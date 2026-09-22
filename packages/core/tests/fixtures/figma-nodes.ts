import type { FigmaNode } from '@usepolder/current-core';

/** A well-built component: auto layout, bound tokens, named layers, variants. */
export const buttonNode: FigmaNode = {
  id: '1:10',
  name: 'Button',
  type: 'COMPONENT_SET',
  componentPropertyDefinitions: { 'Size#1:2': {}, 'Disabled#3:4': {} },
  children: [
    {
      id: '1:11',
      name: 'Size=large',
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

/** A neglected component: no auto layout, raw values, default layer names. */
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
