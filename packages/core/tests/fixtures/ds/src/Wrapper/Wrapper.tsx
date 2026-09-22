const style = { padding: '12px', color: '#ff0000' };

export const Wrapper = ({ children }) => (
  <div style={style}>
    <img src="decoration.png" />
    {children}
  </div>
);
