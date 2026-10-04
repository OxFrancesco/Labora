"""Reopen every Blender source and GLB, render portable exports, assemble the set."""
import argparse
import hashlib
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path
import bmesh
import bpy
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('pets',ROOT/'scripts/blender-pet-collection.py')
pets=importlib.util.module_from_spec(spec);spec.loader.exec_module(pets)
OUT=pets.OUT

def validate():
    checks=[]
    for i,name in enumerate(pets.NAMES,1):
        folder=OUT/f'{i:02d}-{name}'
        bpy.ops.wm.open_mainfile(filepath=str(folder/f'{name}.blend'))
        scene=bpy.context.scene;scene.frame_set(1)
        parts=[o for o in scene.objects if o.get('pet_part')]
        assert parts and all(o.type=='MESH' for o in parts)
        assert len([o for o in parts if o.name.startswith('Expression | smiling eye')])==2
        assert {m.name:m.frame for m in scene.timeline_markers}=={'Rest':1,'Thinking':40,'Done':80}
        volumes=[];vertices=triangles=0
        for o in parts:
            bm=bmesh.new();bm.from_mesh(o.data);volumes.append(abs(bm.calc_volume()));bm.free()
            vertices+=len(o.data.vertices);o.data.calc_loop_triangles();triangles+=len(o.data.loop_triangles)
            assert all(math.isfinite(v) for vert in o.data.vertices for v in vert.co)
        assert max(volumes)>.05, f'{name} lacks volumetric geometry'
        assert all(im.packed_file for im in bpy.data.images if im.source=='FILE' and im.type!='RENDER_RESULT'),f'{name} has unpacked source images'
        pose=[]
        root=next(o for o in scene.objects if o.get('pet_root'))
        for frame in (1,40,80):
            scene.frame_set(frame);bpy.context.view_layer.update()
            pose.append([*root.location,*root.rotation_euler,*root.scale])
        assert len({tuple(v) for v in pose})==3
        scene.frame_set(1)
        data=(folder/f'{name}.glb').read_bytes()
        magic,version,length=struct.unpack_from('<4sII',data)
        assert magic==b'glTF' and version==2 and length==len(data)
        json_length=struct.unpack_from('<I',data,12)[0];gltf=json.loads(data[20:20+json_length])
        assert gltf.get('animations') and not gltf.get('cameras')
        assert all('uri' not in b for b in gltf['buffers'])
        assert all('uri' not in im for im in gltf.get('images',[]))
        assert any('normalTexture' in m for m in gltf['materials'])
        assert not any('baseColorTexture' in m.get('pbrMetallicRoughness',{}) for m in gltf['materials'])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(folder/f'{name}.glb'))
        imported=[o for o in bpy.context.scene.objects if o.type=='MESH']
        assert len(imported)==len(parts),f'{name} mesh count changed'
        scene=pets.stage(480);scene.frame_set(1)
        height=json.loads((folder/'metrics.json').read_text())['bounds']['max'][2]
        target=Vector((0,0,height*.5));scene.camera.location=target+Vector((3.3,-10,2.1));scene.camera.rotation_euler=(target-scene.camera.location).to_track_quat('-Z','Y').to_euler();scene.camera.data.ortho_scale=max(height+.85,3.3)
        scene.cycles.samples=20;scene.render.filepath=str(folder/'glb-reimport.png');bpy.ops.render.render(write_still=True)
        check={'id':i,'name':name,'sourceMeshes':len(parts),'reimportedMeshes':len(imported),'vertices':vertices,'triangles':triangles,'largestMeshVolume':max(volumes),'sourceReopened':True,'packedTextures':True,'glbSelfContained':True,'poseTimelineVerified':True,'glbReimportRender':f'{i:02d}-{name}/glb-reimport.png','files':{ext:{'bytes':(folder/f'{name}.{ext}').stat().st_size,'sha256':hashlib.sha256((folder/f'{name}.{ext}').read_bytes()).hexdigest()} for ext in ('blend','glb')}}
        checks.append(check)
        (OUT/'validation.json').write_text(json.dumps({'blender':bpy.app.version_string,'checks':checks},indent=2))
        print('VERIFIED '+name,flush=True)

def collection():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    roots=[]
    for i,name in enumerate(pets.NAMES,1):
        folder=OUT/f'{i:02d}-{name}'
        with bpy.data.libraries.load(str(folder/f'{name}.blend'),link=False) as (src,dst):dst.collections=[f'{i:02d} {name.title()}']
        coll=dst.collections[0];assert coll;bpy.context.scene.collection.children.link(coll)
        root=next(o for o in coll.all_objects if o.get('pet_root'))
        for o in coll.all_objects:o.animation_data_clear()
        root.location=((i-1)%6*3.4-8.5,(3-(i-1)//6)*4.8,0)
        root.rotation_euler=(0,0,0);root.scale=(1,1,1)
        roots.append(root)
    scene=pets.stage(1600)
    scene.render.resolution_x=1900;scene.render.resolution_y=1400
    target=Vector((0,7.2,1));scene.camera.location=(0,-25,29);scene.camera.rotation_euler=(target-scene.camera.location).to_track_quat('-Z','Y').to_euler();scene.camera.data.ortho_scale=23
    for o in scene.objects:
        if o.type=='LIGHT':o.location*=3;o.data.energy*=8;o.data.size*=3;o.rotation_euler=(Vector((0,5,0))-o.location).to_track_quat('-Z','Y').to_euler()
    scene.cycles.samples=32;scene.render.filepath=str(OUT/'collection.png')
    note=bpy.data.texts.new('READ ME');note.write('Labora | 24 pets\nEach numbered collection contains one editable mesh character.\nIndividual files include rest, thinking, and done pose timelines.\nThis master file arranges the resting characters together.\nNo concept image is used as model geometry.\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'labora-pets-collection.blend'),compress=True)
    bpy.ops.render.render(write_still=True)
    scene.render.resolution_x=1280;scene.render.resolution_y=944;scene.cycles.samples=12
    scene.frame_start=1;scene.frame_end=72;scene.render.fps=12
    for root in roots:
        root.rotation_euler.z=0;root.keyframe_insert(data_path='rotation_euler',frame=1)
        root.rotation_euler.z=math.tau;root.keyframe_insert(data_path='rotation_euler',frame=72)
        # Linear turntable rotation, independent of each pet's pose timeline.
        action=root.animation_data.action
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        for point in fc.keyframe_points:point.interpolation='LINEAR'
    scene.frame_set(1)
    (OUT/'turntable-frames').mkdir(exist_ok=True)
    for frame in range(1,73):
        scene.frame_set(frame);scene.render.filepath=str(OUT/f'turntable-frames/{frame:04d}.png');bpy.ops.render.render(write_still=True)
    print('COLLECTION_COMPLETE',flush=True)

a=argparse.ArgumentParser();a.add_argument('--validate',action='store_true');a.add_argument('--collection',action='store_true')
args=a.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if args.validate:validate()
if args.collection:collection()
