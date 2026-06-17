export interface PppoeService {
  id: string;
  username: string;            // name del /ppp secret — clave de upsert
  password: string;            // verdad técnica del router
  profile: string | null;     // /ppp profile (IP-Air-* / IP-REDUCCION / *-PUB)
  remoteAddress: string | null; // IP fija (remote-address): CGNAT o pública
  status: string;             // enabled | disabled (del secret)
  nasId: string;              // router donde vive (FK NasServer)
  contractId: string | null; // FK Contract — null = sin contrato asociado aún
  createdAt: string;
}
