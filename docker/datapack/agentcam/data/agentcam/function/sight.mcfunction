# one quarter-block step of a line from the bot toward a spot (agentcam:sight_try): open all the way (#so 1 once #sn
# steps are done), or a block in the way, leaves too (the camera's fast graphics draw leaves opaque)
scoreboard players remove #sn agentcam_y 1
execute if score #sn agentcam_y matches ..0 run return run scoreboard players set #so agentcam_y 1
execute unless block ~ ~ ~ #agentcam:open run return 0
execute positioned ^ ^ ^0.25 run function agentcam:sight
