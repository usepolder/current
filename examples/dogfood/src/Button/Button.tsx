import { tokens } from '../tokens';

export interface ButtonProps {
  size: 'small' | 'large';
  isDisabled?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}

export const Button = ({ size, isDisabled, onPress, children }: ButtonProps) => (
  <button
    className={tokens.button[size]}
    aria-disabled={isDisabled}
    onClick={onPress}
  >
    <svg aria-hidden="true" className={tokens.icon} />
    {children}
  </button>
);
