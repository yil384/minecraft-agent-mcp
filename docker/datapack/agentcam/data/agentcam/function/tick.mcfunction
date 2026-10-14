# every tick, only while a camera is in the world
execute unless entity @a[tag=agentcam] run return 0
# night vision on the camera player, again whenever it is gone (a respawn, a dimension change): never a black picture
execute as @a[tag=agentcam] unless predicate agentcam:night_vision run effect give @s minecraft:night_vision infinite 0 true
execute unless entity @a[tag=agentcam_target] run return 0
function agentcam:enclosure
# a portal, a respawn far away: the camera player is not near the bot (only the bot's own dimension is searched)
scoreboard players remove #cd agentcam_cd 1
execute if score #cd agentcam_cd matches ..-100 run scoreboard players set #cd agentcam_cd 0
execute if score #cd agentcam_cd matches ..0 at @a[tag=agentcam_target,limit=1] unless entity @a[tag=agentcam,distance=..48] run function agentcam:regroup
# after a regroup the ride is asked for again from scratch at 1, 2.5 and 5 s: the client drops a ride on an entity it
# does not have yet (it is still loading the other dimension), and the server sends a ride only when it changes
execute if score #rr agentcam_rr matches ..100 run scoreboard players add #rr agentcam_rr 1
execute if score #rr agentcam_rr matches 20 run function agentcam:reride
execute if score #rr agentcam_rr matches 50 run function agentcam:reride
execute if score #rr agentcam_rr matches 100 run function agentcam:reride
# the eye: an invisible display entity the camera rides; Minecraft interpolates its teleports on the client over
# teleport_duration ticks (3), and its yaw follows the bot's damped (agentcam:yaw), so the follow is smooth
execute unless entity @e[type=minecraft:item_display,tag=agentcam_eye] at @a[tag=agentcam_target,limit=1] run function agentcam:new_eye
function agentcam:yaw
execute if entity @a[tag=agentcam_target,tag=agentcam_shut] run function agentcam:outside
# enclosed: the views from outside, never first person over the shoulder
execute if entity @a[tag=agentcam_target,tag=agentcam_shut] run tag @a[tag=agentcam] remove agentcam_fp
execute unless entity @a[tag=agentcam_target,tag=agentcam_shut] run function agentcam:shoulder
# out of the shelter: the next one chooses its spot afresh
execute unless entity @a[tag=agentcam_target,tag=agentcam_shut] run scoreboard players set #on agentcam_y 0
execute unless entity @a[tag=agentcam_target,tag=agentcam_shut] run tag @a[tag=agentcam_target] remove agentcam_deep
function agentcam:view
