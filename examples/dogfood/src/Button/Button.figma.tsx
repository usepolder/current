// A Figma Code Connect mapping, in the shape `figma connect publish` reads.
// CO12 is answered from this file: it is the repo stating which Figma node
// this component implements, and Current checks that it is the node the
// audit scores (`figma: "1:10"` in .polder.yml).
import figma from '@figma/code-connect/react';
import { Button } from './Button';

figma.connect(Button, 'https://www.figma.com/design/fixture-file/DS?node-id=1-10', {
  props: {
    size: figma.enum('Size', { Small: 'small', Large: 'large' }),
    isDisabled: figma.boolean('Disabled'),
    children: figma.string('Label'),
  },
  example: ({ size, isDisabled, children }) => (
    <Button size={size} isDisabled={isDisabled}>
      {children}
    </Button>
  ),
});
