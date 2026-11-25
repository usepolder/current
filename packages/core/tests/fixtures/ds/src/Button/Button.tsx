import { tokens } from '../tokens';

export interface ButtonProps {
  size: 'small' | 'large';
  /** Mirrors the Figma `State` variant, so CO9 has a counterpart to find. */
  state?: 'default' | 'hover' | 'pressed';
  isDisabled?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}

export const Button = ({ size, state, isDisabled, onPress, children }: ButtonProps) => (
  <button
    className={tokens.button[size]}
    data-state={state}
    aria-disabled={isDisabled}
    onClick={onPress}
  >
    <svg aria-hidden="true" className={tokens.icon} />
    {children}
  </button>
);
