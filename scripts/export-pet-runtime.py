import bpy, json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets/characters3d/sources'
OUT = ROOT / 'assets/characters3d'
results = []
sources = sorted(SOURCE.glob('*.blend'))
if len(sources) != 24:
    raise RuntimeError('Expected all 24 editable Blender sources before exporting runtime models')
for path in sources:
    bpy.ops.wm.open_mainfile(filepath=str(path))
    bpy.context.scene.frame_set(1)
    bpy.ops.object.select_all(action='DESELECT')
    parts = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('pet_part') and 'smiling eye' not in o.name]
    for obj in parts:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        obj.data.calc_loop_triangles()
        count = len(obj.data.loop_triangles)
        if count > 15000:
            mod = obj.modifiers.new('Runtime detail', 'DECIMATE')
            mod.ratio = max(0.08, 15000 / count)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.wm.usd_export(filepath=str(OUT / (path.stem + '.usdz')), selected_objects_only=True, export_animation=False, export_materials=True, generate_preview_surface=True, export_textures_mode='NEW', overwrite_textures=True, export_lights=False, export_cameras=False, convert_world_material=False, convert_orientation=True, export_global_forward_selection='NEGATIVE_Z', export_global_up_selection='Y')
    triangles = 0
    for obj in parts:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    results.append({'name':path.stem, 'meshes':len(parts), 'triangles':triangles, 'bytes':(OUT / (path.stem + '.usdz')).stat().st_size})
    print('EXPORTED', results[-1], flush=True)
(OUT / 'collection-runtime.json').write_text(json.dumps(results, indent=2)+'\n')
