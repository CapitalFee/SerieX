// Placeholder content for a window kind that has no screen of its own.
export default function UnderConstruction({ title }: { title: string }) {
  return (
    <div className="sx-under-construction">
      <div>Under construction: {title}</div>
    </div>
  );
}
