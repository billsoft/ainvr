import {Matrix4, Vector3} from 'three'
import {erpPoint, type PanoramaCamera} from './panoramaDetection'

type Point = [number, number]
const validCamera = (camera: PanoramaCamera | null): camera is PanoramaCamera =>
  !!camera && [camera.view, camera.projection].every(m =>
    m.length === 16 && m.every(Number.isFinite))

/** Inverse of the player's reflected-X ERP sphere mapping. Coordinates are
 * always source ERP coordinates, never persisted viewport pixels or yaw. */
export function viewportToErp(
  x: number, y: number, camera: PanoramaCamera | null,
  width: number, height: number,
): Point | null {
  if (!validCamera(camera) || ![x,y,width,height].every(Number.isFinite) ||
    width <= 0 || height <= 0 || x < 0 || x > width || y < 0 || y > height) return null
  const view = new Matrix4().fromArray(camera.view)
  const projection = new Matrix4().fromArray(camera.projection)
  if (Math.abs(view.determinant()) < 1e-12 ||
    Math.abs(projection.determinant()) < 1e-12) return null
  const world = view.invert()
  const origin = new Vector3().setFromMatrixPosition(world)
  // PanoramaView places the camera at the centre of the sphere. Fail closed
  // if a future view changes that invariant instead of silently misplacing edits.
  if (origin.lengthSq() > 1e-12) return null
  const ray = new Vector3(2*x/width-1, 1-2*y/height, .5)
    .applyMatrix4(projection.invert()).applyMatrix4(world).sub(origin).normalize()
  if (![ray.x,ray.y,ray.z].every(Number.isFinite) || ray.lengthSq() < .9) return null
  let longitude = Math.atan2(ray.z,ray.x) / (2*Math.PI)
  longitude = (longitude % 1 + 1) % 1
  return [longitude,Math.acos(Math.max(-1,Math.min(1,ray.y)))/Math.PI]
}

/** Projects a source point for editing handles. Hidden or offscreen vertices
 * must not leave invisible draggable hit targets over the visible picture. */
export function erpToViewport(
  point: Point, camera: PanoramaCamera | null, width: number, height: number,
): Point | null {
  if (!validCamera(camera) || ![...point,width,height].every(Number.isFinite) ||
    width <= 0 || height <= 0 || point[1] < 0 || point[1] > 1) return null
  const view = new Matrix4().fromArray(camera.view)
  const projection = new Matrix4().fromArray(camera.projection)
  if (Math.abs(view.determinant()) < 1e-12 ||
    Math.abs(projection.determinant()) < 1e-12) return null
  const p = new Vector3(...erpPoint(point[0],point[1],1,1)).applyMatrix4(view)
  if (p.z > -.1) return null
  p.applyMatrix4(projection)
  if (![p.x,p.y].every(Number.isFinite) || Math.abs(p.x)>1+1e-10 || Math.abs(p.y)>1+1e-10) return null
  return [(p.x+1)*width/2,(1-p.y)*height/2]
}
